const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/authRoutes');
const dashboardApiRoutes = require('./routes/dashboardApi');
const publicApiRoutes = require('./routes/publicApi');
const { sessionAuth } = require('./middleware/auth');
const store = require('./store');

const app = express();
app.set('json spaces', 2);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Database Connection Middleware ─────────────────────────
const dbCheck = async (req, res, next) => {
    try {
        await store.connectDB();
        next();
    } catch (err) {
        console.error('Database connection failed:', err);
        res.status(500).json({ success: false, error: 'Database connection failed: ' + err.message });
    }
};

// ─── Page Routes ────────────────────────────────────────────

app.get('/', (req, res) => {
    const token = req.cookies?.auth_token;
    if (token) return res.redirect('/dashboard');
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    const token = req.cookies?.auth_token;
    if (token) return res.redirect('/dashboard');
    res.render('login');
});

app.get('/register', (req, res) => {
    const token = req.cookies?.auth_token;
    if (token) return res.redirect('/dashboard');
    res.render('register');
});

app.get('/dashboard', sessionAuth, (req, res) => {
    res.render('dashboard', { user: req.user });
});

app.get('/docs', (req, res) => {
    res.render('docs');
});

// ─── Auth API Routes ────────────────────────────────────────
app.use('/auth', dbCheck, authRoutes);

// ─── Dashboard API Routes ───────────────────────────────────
app.use('/api', dbCheck, dashboardApiRoutes);

// ─── Public API Routes (v1) ─────────────────────────────────
app.use('/v1', dbCheck, publicApiRoutes);

// ─── Start Server ───────────────────────────────────────────
const PORT = process.env.PORT || 3015;
if (require.main === module) {
    app.listen(PORT, () => console.log(`ZentraPay listening on port ${PORT} — https://ZentraPay.my.id`));
}

// Export for tests & Vercel serverless
module.exports = app;
