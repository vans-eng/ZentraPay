const express = require('express');
const router = express.Router();
const store = require('../store');
const { generateToken } = require('../middleware/auth');

// ─── POST /auth/register ────────────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { username, password, confirm_password } = req.body;

        if (!username || !password || !confirm_password) {
            return res.status(400).json({ success: false, error: 'Semua field wajib diisi' });
        }
        if (username.length < 3 || username.length > 20) {
            return res.status(400).json({ success: false, error: 'Username harus 3-20 karakter' });
        }
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ success: false, error: 'Username hanya boleh huruf, angka, dan underscore' });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password minimal 6 karakter' });
        }
        if (password !== confirm_password) {
            return res.status(400).json({ success: false, error: 'Konfirmasi password tidak cocok' });
        }
        if (await store.userExists(username)) {
            return res.status(409).json({ success: false, error: 'Username sudah digunakan' });
        }

        const user = await store.createUser(username, password);
        res.json({ success: true, message: 'Registrasi berhasil! Silakan login.', user: { username: user.username } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message || 'Gagal registrasi' });
    }
});

// ─── POST /auth/login ───────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Username dan password wajib diisi' });
        }

        const user = await store.authenticateUser(username, password);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Username atau password salah' });
        }

        const token = generateToken(user);
        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        res.json({ success: true, user: { username: user.username } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message || 'Gagal login' });
    }
});

// ─── POST /auth/logout ──────────────────────────────────────
router.post('/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

module.exports = router;
