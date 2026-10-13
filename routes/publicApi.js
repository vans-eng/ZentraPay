const express = require('express');
const router = express.Router();
const store = require('../store');
const GoMerchant = require('../GoMerchant');
const QRCode = require('qrcode');
const { apiKeyAuth } = require('../middleware/auth');

const sdk = new GoMerchant();

// ─── POST /v1/deposit/create ────────────────────────────────
router.post('/deposit/create', apiKeyAuth, async (req, res) => {
    try {
        const { amount, static_qr } = req.body;
        const qrToUse = static_qr || req.merchant.static_qr;

        if (!amount || !qrToUse) {
            return res.status(400).json({
                success: false,
                error: 'Parameter amount wajib diisi, dan static_qr wajib diisi atau sudah disimpan di Dashboard',
                code: 'MISSING_PARAMS'
            });
        }

        if (isNaN(amount) || parseInt(amount) < 1) {
            return res.status(400).json({
                success: false,
                error: 'Amount harus berupa angka positif',
                code: 'INVALID_AMOUNT'
            });
        }

        // Generate dynamic QRIS
        const qrisData = await sdk.createDynamicQRIS(parseInt(amount), qrToUse);

        // Store the deposit
        const deposit = await store.createDeposit({
            user_id: req.merchant.user_id,
            gopay_account_id: req.merchant.gopay_account_id,
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
        res.status(500).json({
            success: false,
            error: e.message || 'Internal server error',
            code: 'CREATE_FAILED'
        });
    }
});

// ─── POST /v1/deposit/status ────────────────────────────────
router.post('/deposit/status', apiKeyAuth, async (req, res) => {
    try {
        const { deposit_id } = req.body;

        if (!deposit_id) {
            return res.status(400).json({
                success: false,
                error: 'Parameter deposit_id wajib diisi',
                code: 'MISSING_PARAMS'
            });
        }

        const deposit = await store.getDeposit(deposit_id);
        if (!deposit) {
            return res.status(404).json({
                success: false,
                error: 'Deposit tidak ditemukan',
                code: 'NOT_FOUND'
            });
        }

        // If not pending, return stored status
        if (deposit.status !== 'PENDING') {
            return res.json({
                success: true,
                data: {
                    deposit_id: deposit.deposit_id,
                    amount: deposit.amount,
                    status: deposit.status,
                    created_at: deposit.created_at,
                    expired_at: deposit.expired_at,
                    paid_at: deposit.paid_at,
                    cancelled_at: deposit.cancelled_at
                }
            });
        }

        // Check with GoBiz journals for payment
        try {
            const user = await sdk.getMe(req.merchant.access_token);
            const logs = await sdk.getJournals(
                req.merchant.access_token,
                user.user.merchant_id,
                deposit.created_at
            );
            const amountSearch = deposit.amount * 100;
            const found = (logs.hits || []).find(h => {
                const txTime = new Date(h.time).getTime();
                const depositTime = new Date(deposit.created_at).getTime();
                return h.amount === amountSearch && txTime >= depositTime;
            });

            if (found) {
                const updatedDeposit = await store.updateDeposit(deposit_id, {
                    status: 'PAID',
                    paid_at: new Date(),
                    payment_data: {
                        reference_id: found.reference_id,
                        payment_type: found.metadata?.transaction?.payment_type,
                        transaction_time: found.time
                    }
                });

                return res.json({
                    success: true,
                    data: {
                        deposit_id: updatedDeposit.deposit_id,
                        amount: updatedDeposit.amount,
                        status: 'PAID',
                        created_at: updatedDeposit.created_at,
                        paid_at: updatedDeposit.paid_at,
                        payment_data: updatedDeposit.payment_data
                    }
                });
            }
        } catch (checkErr) {
            // Journal check failed, return current stored status
        }

        res.json({
            success: true,
            data: {
                deposit_id: deposit.deposit_id,
                amount: deposit.amount,
                status: deposit.status,
                created_at: deposit.created_at,
                expired_at: deposit.expired_at,
                paid_at: deposit.paid_at
            }
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message || 'Internal server error',
            code: 'STATUS_CHECK_FAILED'
        });
    }
});

// ─── POST /v1/deposit/cancel ────────────────────────────────
router.post('/deposit/cancel', apiKeyAuth, async (req, res) => {
    try {
        const { deposit_id } = req.body;

        if (!deposit_id) {
            return res.status(400).json({
                success: false,
                error: 'Parameter deposit_id wajib diisi',
                code: 'MISSING_PARAMS'
            });
        }

        const deposit = await store.getDeposit(deposit_id);
        if (!deposit) {
            return res.status(404).json({
                success: false,
                error: 'Deposit tidak ditemukan',
                code: 'NOT_FOUND'
            });
        }

        if (deposit.status !== 'PENDING') {
            return res.status(400).json({
                success: false,
                error: `Deposit tidak dapat dibatalkan karena statusnya sudah ${deposit.status}`,
                code: 'CANNOT_CANCEL'
            });
        }

        const cancelled = await store.cancelDeposit(deposit_id);

        res.json({
            success: true,
            data: {
                deposit_id: cancelled.deposit_id,
                amount: cancelled.amount,
                status: cancelled.status,
                cancelled_at: cancelled.cancelled_at
            }
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message || 'Internal server error',
            code: 'CANCEL_FAILED'
        });
    }
});

// ─── POST /v1/deposit/history ───────────────────────────────
router.post('/deposit/history', apiKeyAuth, async (req, res) => {
    try {
        const { limit = 50, status = null } = req.body;

        const deposits = await store.listDeposits(req.merchant.user_id, {
            limit: Math.min(parseInt(limit) || 50, 100),
            status
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

        res.json({
            success: true,
            data: {
                total: cleaned.length,
                deposits: cleaned
            }
        });
    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message || 'Internal server error',
            code: 'HISTORY_FAILED'
        });
    }
});

// ─── GET /v1/qris/image/:deposit_id (PUBLIC, no apikey) ─────
router.get('/qris/image/:deposit_id', async (req, res) => {
    try {
        const deposit = await store.getDeposit(req.params.deposit_id);
        if (!deposit || !deposit.qr_string) {
            return res.status(404).json({
                success: false,
                error: 'QR image not found',
                code: 'NOT_FOUND'
            });
        }

        const qrBuffer = await QRCode.toBuffer(deposit.qr_string, {
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
        });

        res.set({
            'Content-Type': 'image/png',
            'Content-Disposition': `inline; filename="QRIS-${deposit.deposit_id}.png"`,
            'Cache-Control': 'public, max-age=1800'
        });

        res.send(qrBuffer);
    } catch (e) {
        res.status(500).json({
            success: false,
            error: 'Failed to generate QR image',
            code: 'QR_GEN_FAILED'
        });
    }
});

module.exports = router;
