const express = require('express');
const router = express.Router();
const store = require('../store');
const GoMerchant = require('../GoMerchant');
const { apiAuth } = require('../middleware/auth');

const sdk = new GoMerchant();

// All dashboard routes require session auth
router.use(apiAuth);

// ─── Dashboard Stats ────────────────────────────────────────
router.get('/stats', async (req, res) => {
    try {
        const accounts = await store.getGopayAccounts(req.user._id);
        const deposits = await store.listDeposits(req.user._id, { limit: 100 });
        const keys = await store.listApiKeys(req.user._id);

        const paid = deposits.filter(d => d.status === 'PAID');
        const pending = deposits.filter(d => d.status === 'PENDING');
        const totalRevenue = paid.reduce((sum, d) => sum + d.amount, 0);

        res.json({
            success: true,
            data: {
                accounts_count: accounts.length,
                total_deposits: deposits.length,
                paid_count: paid.length,
                pending_count: pending.length,
                total_revenue: totalRevenue,
                api_keys_count: keys.length
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── GoPay: Request OTP ─────────────────────────────────────
router.post('/gopay/request-otp', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, error: 'Nomor telepon wajib diisi' });
        }

        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const data = await sdk.requestOtp(cleanPhone);
        res.json({ success: true, data, phone: cleanPhone });
    } catch (e) {
        res.status(400).json({ success: false, error: e.response?.data || e.message });
    }
});

// ─── GoPay: Verify OTP & Link Account ───────────────────────
router.post('/gopay/verify-otp', async (req, res) => {
    try {
        const { otp, otp_token, phone } = req.body;
        if (!otp || !otp_token) {
            return res.status(400).json({ success: false, error: 'OTP dan OTP token wajib diisi' });
        }

        // Verify OTP with GoBiz
        const verifyData = await sdk.verifyOtp(otp, otp_token);
        const accessToken = verifyData?.data?.access_token || verifyData?.access_token;
        const refreshToken = verifyData?.data?.refresh_token || verifyData?.refresh_token || '';

        if (!accessToken) {
            return res.status(400).json({ success: false, error: 'Gagal mendapatkan access token' });
        }

        // Get merchant info
        let merchantId = '';
        let merchantName = '';
        try {
            const meData = await sdk.getMe(accessToken);
            merchantId = meData?.user?.merchant_id || '';
            merchantName = meData?.user?.name || meData?.user?.business_name || '';
        } catch (meErr) {
            // Non-fatal — we can still link without merchant info
        }

        // Link account to user
        const account = await store.linkGopayAccount({
            user_id: req.user._id,
            phone: phone || '',
            access_token: accessToken,
            refresh_token: refreshToken,
            merchant_id: merchantId,
            merchant_name: merchantName
        });

        res.json({
            success: true,
            message: 'Akun GoPay berhasil dihubungkan!',
            data: {
                _id: account._id,
                phone: account.phone,
                merchant_id: account.merchant_id,
                merchant_name: account.merchant_name,
                linked_at: account.linked_at,
                has_static_qr: !!account.static_qr
            }
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.response?.data || e.message });
    }
});

// ─── GoPay: List Accounts ───────────────────────────────────
router.get('/gopay/accounts', async (req, res) => {
    try {
        const accounts = await store.getGopayAccounts(req.user._id);
        const safeAccounts = accounts.map(a => ({
            _id: a._id,
            phone: a.phone,
            merchant_id: a.merchant_id,
            merchant_name: a.merchant_name,
            has_static_qr: !!a.static_qr,
            static_qr_preview: a.static_qr ? a.static_qr.substring(0, 30) + '...' : null,
            linked_at: a.linked_at,
            token_updated_at: a.token_updated_at
        }));
        res.json({ success: true, data: safeAccounts });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── GoPay: Save Static QR ─────────────────────────────────
router.post('/gopay/save-qr', async (req, res) => {
    try {
        const { account_id, static_qr } = req.body;
        if (!account_id || !static_qr) {
            return res.status(400).json({ success: false, error: 'Account ID dan Static QR wajib diisi' });
        }

        // Verify ownership
        const account = await store.getGopayAccountById(account_id);
        if (!account || account.user_id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, error: 'Akses ditolak' });
        }

        const updated = await store.saveStaticQr(account_id, static_qr);
        res.json({ success: true, message: 'Static QR berhasil disimpan', data: updated });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── GoPay: Unlink Account ──────────────────────────────────
router.post('/gopay/unlink', async (req, res) => {
    try {
        const { account_id } = req.body;
        if (!account_id) {
            return res.status(400).json({ success: false, error: 'Account ID wajib diisi' });
        }

        const account = await store.getGopayAccountById(account_id);
        if (!account || account.user_id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, error: 'Akses ditolak' });
        }

        await store.deleteGopayAccount(account_id);
        res.json({ success: true, message: 'Akun GoPay berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── QRIS: Create Dynamic QRIS ─────────────────────────────
router.post('/qris/create', async (req, res) => {
    try {
        const { account_id, amount } = req.body;
        if (!account_id || !amount) {
            return res.status(400).json({ success: false, error: 'Account ID dan amount wajib diisi' });
        }
        if (isNaN(amount) || parseInt(amount) < 1) {
            return res.status(400).json({ success: false, error: 'Amount harus angka positif' });
        }

        // Get GoPay account
        const account = await store.getGopayAccountById(account_id);
        if (!account || account.user_id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, error: 'Akses ditolak' });
        }
        if (!account.static_qr) {
            return res.status(400).json({ success: false, error: 'Static QR belum diatur untuk akun ini' });
        }

        // Generate dynamic QRIS
        const qrisData = await sdk.createDynamicQRIS(parseInt(amount), account.static_qr);

        // Store deposit
        const deposit = await store.createDeposit({
            user_id: req.user._id,
            gopay_account_id: account._id,
            amount: parseInt(amount),
            qr_string: qrisData.qr_string
        });

        const baseUrl = `${req.protocol}://${req.get('host')}`;

        res.json({
            success: true,
            data: {
                deposit_id: deposit.deposit_id,
                amount: deposit.amount,
                qr_image_url: `${baseUrl}/v1/qris/image/${deposit.deposit_id}`,
                qr_string: deposit.qr_string,
                status: deposit.status,
                created_at: deposit.created_at,
                expired_at: deposit.expired_at
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── QRIS: Check Payment Status ────────────────────────────
router.post('/qris/status', async (req, res) => {
    try {
        const { deposit_id } = req.body;
        if (!deposit_id) {
            return res.status(400).json({ success: false, error: 'Deposit ID wajib diisi' });
        }

        const deposit = await store.getDeposit(deposit_id);
        if (!deposit) {
            return res.status(404).json({ success: false, error: 'Deposit tidak ditemukan' });
        }
        if (deposit.user_id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, error: 'Akses ditolak' });
        }

        // If not pending, return stored status
        if (deposit.status !== 'PENDING') {
            return res.json({ success: true, data: deposit });
        }

        // Check with GoBiz journals
        const account = await store.getGopayAccountById(deposit.gopay_account_id);
        if (account) {
            try {
                const user = await sdk.getMe(account.access_token);
                const logs = await sdk.getJournals(account.access_token, user.user.merchant_id, deposit.created_at);
                const amountSearch = deposit.amount * 100;
                const found = (logs.hits || []).find(h => {
                    const txTime = new Date(h.time).getTime();
                    const depositTime = new Date(deposit.created_at).getTime();
                    return h.amount === amountSearch && txTime >= depositTime;
                });

                if (found) {
                    const updated = await store.updateDeposit(deposit_id, {
                        status: 'PAID',
                        paid_at: new Date(),
                        payment_data: {
                            reference_id: found.reference_id,
                            payment_type: found.metadata?.transaction?.payment_type,
                            transaction_time: found.time
                        }
                    });
                    return res.json({ success: true, data: updated });
                }
            } catch (checkErr) {
                // Journal check failed — return stored status
            }
        }

        res.json({ success: true, data: deposit });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── QRIS: Cancel Deposit ───────────────────────────────────
router.post('/qris/cancel', async (req, res) => {
    try {
        const { deposit_id } = req.body;
        if (!deposit_id) {
            return res.status(400).json({ success: false, error: 'Deposit ID wajib diisi' });
        }

        const deposit = await store.getDeposit(deposit_id);
        if (!deposit) {
            return res.status(404).json({ success: false, error: 'Deposit tidak ditemukan' });
        }
        if (deposit.user_id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, error: 'Akses ditolak' });
        }
        if (deposit.status !== 'PENDING') {
            return res.status(400).json({ success: false, error: `Tidak bisa dibatalkan, status: ${deposit.status}` });
        }

        const cancelled = await store.cancelDeposit(deposit_id);
        res.json({ success: true, data: cancelled });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Deposits: List History ─────────────────────────────────
router.get('/deposits', async (req, res) => {
    try {
        const { limit = 50, status } = req.query;
        const deposits = await store.listDeposits(req.user._id, {
            limit: Math.min(parseInt(limit) || 50, 100),
            status: status || null
        });

        const cleaned = deposits.map(d => ({
            deposit_id: d.deposit_id,
            amount: d.amount,
            status: d.status,
            created_at: d.created_at,
            expired_at: d.expired_at,
            paid_at: d.paid_at,
            cancelled_at: d.cancelled_at,
            payment_data: d.payment_data
        }));

        res.json({ success: true, data: { total: cleaned.length, deposits: cleaned } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── API Keys: Create ───────────────────────────────────────
router.post('/keys/create', async (req, res) => {
    try {
        const { name, gopay_account_id } = req.body;
        if (!gopay_account_id) {
            return res.status(400).json({ success: false, error: 'Pilih akun GoPay untuk API key ini' });
        }

        // Verify ownership of GoPay account
        const account = await store.getGopayAccountById(gopay_account_id);
        if (!account || account.user_id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, error: 'Akses ditolak' });
        }

        const newKey = await store.createApiKey({
            user_id: req.user._id,
            name: name || 'Default Key',
            gopay_account_id
        });

        res.json({
            success: true,
            data: {
                key: newKey.key,
                name: newKey.name,
                created_at: newKey.created_at
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── API Keys: List ─────────────────────────────────────────
router.get('/keys', async (req, res) => {
    try {
        const keys = await store.listApiKeys(req.user._id);
        const safeKeys = keys.map(k => ({
            key: k.key,
            key_preview: k.key.slice(0, 8) + '...' + k.key.slice(-6),
            name: k.name,
            gopay_account_id: k.gopay_account_id,
            created_at: k.created_at,
            last_used: k.last_used
        }));
        res.json({ success: true, data: safeKeys });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── API Keys: Delete ───────────────────────────────────────
router.post('/keys/delete', async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) {
            return res.status(400).json({ success: false, error: 'API key wajib diisi' });
        }

        // Verify ownership
        const keyData = await store.getApiKeyByKey(key);
        if (!keyData || keyData.user_id.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, error: 'Akses ditolak' });
        }

        await store.deleteApiKey(key);
        res.json({ success: true, message: 'API key berhasil dihapus' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
