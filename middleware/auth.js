const jwt = require('jsonwebtoken');
const store = require('../store');
const GoMerchant = require('../GoMerchant');

const JWT_SECRET = process.env.JWT_SECRET || 'zentrapay-secret-key-change-in-production';
const sdk = new GoMerchant();

/**
 * Generate a JWT token for a user.
 */
function generateToken(user) {
    return jwt.sign(
        { _id: user._id, username: user.username },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

/**
 * Session auth middleware for page routes.
 * Redirects to /login if unauthenticated.
 */
function sessionAuth(req, res, next) {
    const token = req.cookies?.auth_token;
    if (!token) return res.redirect('/login');
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        res.clearCookie('auth_token');
        return res.redirect('/login');
    }
}

/**
 * API auth middleware for AJAX/dashboard API calls.
 * Returns JSON errors instead of redirects.
 */
function apiAuth(req, res, next) {
    const token = req.cookies?.auth_token;
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Session expired' });
    }
}

/**
 * API key auth middleware for external integrations (v1 public API).
 * Reads x-api-key header, validates, refreshes GoPay token if needed.
 */
async function apiKeyAuth(req, res, next) {
    const apikey = req.headers['x-api-key'];
    if (!apikey) {
        return res.status(401).json({
            success: false,
            error: 'Missing x-api-key header',
            code: 'MISSING_API_KEY'
        });
    }

    const keyData = await store.getApiKeyByKey(apikey);
    if (!keyData) {
        return res.status(401).json({
            success: false,
            error: 'Invalid API key',
            code: 'INVALID_API_KEY'
        });
    }

    await store.touchApiKey(apikey);

    // Resolve the linked GoPay account
    if (!keyData.gopay_account_id) {
        return res.status(400).json({
            success: false,
            error: 'No GoPay account linked to this API key',
            code: 'NO_GOPAY_LINKED'
        });
    }

    const gopayAccount = await store.getGopayAccountById(keyData.gopay_account_id);
    if (!gopayAccount) {
        return res.status(400).json({
            success: false,
            error: 'Linked GoPay account not found',
            code: 'GOPAY_NOT_FOUND'
        });
    }

    // Validate access token, silently refresh if expired
    try {
        await sdk.getMe(gopayAccount.access_token);
        req.merchant = {
            apikey: keyData.key,
            user_id: keyData.user_id,
            access_token: gopayAccount.access_token,
            refresh_token: gopayAccount.refresh_token,
            merchant_id: gopayAccount.merchant_id,
            static_qr: gopayAccount.static_qr,
            gopay_account_id: gopayAccount._id
        };
        return next();
    } catch (err) {
        // Token might be expired — attempt silent refresh
        if (gopayAccount.refresh_token) {
            try {
                const refreshResult = await sdk.refreshToken(gopayAccount.refresh_token);
                const newAccessToken = refreshResult?.data?.access_token || refreshResult?.access_token;
                const newRefreshToken = refreshResult?.data?.refresh_token || refreshResult?.refresh_token || gopayAccount.refresh_token;

                if (newAccessToken) {
                    await store.updateGopayAccount(gopayAccount._id, {
                        access_token: newAccessToken,
                        refresh_token: newRefreshToken,
                        token_updated_at: new Date()
                    });

                    req.merchant = {
                        apikey: keyData.key,
                        user_id: keyData.user_id,
                        access_token: newAccessToken,
                        refresh_token: newRefreshToken,
                        merchant_id: gopayAccount.merchant_id,
                        static_qr: gopayAccount.static_qr,
                        gopay_account_id: gopayAccount._id
                    };
                    return next();
                }
            } catch (refreshErr) {
                // Refresh also failed
            }
        }

        return res.status(401).json({
            success: false,
            error: 'Token expired. Please re-link your GoPay account.',
            code: 'TOKEN_EXPIRED'
        });
    }
}

module.exports = { sessionAuth, apiAuth, apiKeyAuth, generateToken, JWT_SECRET };
