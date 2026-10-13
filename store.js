const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ─── MongoDB Connection ─────────────────────────────────────
// Standard multi-seed replicaSet URL to avoid querySrv DNS issues
let MONGO_URI = process.env.MONGODB_URI || 'mongodb://purplegamingboom_db_user:WO3o5hVxmHtrCdDN@ac-mrqqfhb-shard-00-00.xutfmjs.mongodb.net:27017,ac-mrqqfhb-shard-00-01.xutfmjs.mongodb.net:27017,ac-mrqqfhb-shard-00-02.xutfmjs.mongodb.net:27017/gomerch?ssl=true&replicaSet=atlas-k4oiny-shard-0&authSource=admin&retryWrites=true&w=majority';

if (MONGO_URI.includes('mongodb+srv://') && MONGO_URI.includes('payment.xutfmjs.mongodb.net')) {
    console.log('Detected mongodb+srv URL for payment cluster. Converting to replica set URL.');
    MONGO_URI = 'mongodb://purplegamingboom_db_user:WO3o5hVxmHtrCdDN@ac-mrqqfhb-shard-00-00.xutfmjs.mongodb.net:27017,ac-mrqqfhb-shard-00-01.xutfmjs.mongodb.net:27017,ac-mrqqfhb-shard-00-02.xutfmjs.mongodb.net:27017/gomerch?ssl=true&replicaSet=atlas-k4oiny-shard-0&authSource=admin&retryWrites=true&w=majority';
}

let connectionPromise = null;

async function connectDB() {
    if (mongoose.connection.readyState === 1) return mongoose.connection;
    if (connectionPromise) return connectionPromise;

    console.log('Connecting to MongoDB Atlas...');
    connectionPromise = mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000
    }).then(() => {
        console.log('Successfully connected to MongoDB Atlas.');
        return mongoose.connection;
    }).catch(err => {
        connectionPromise = null;
        console.error('MongoDB connection error:', err.message);
        throw err;
    });

    return connectionPromise;
}

// Initial connection (runs in background)
connectDB().catch(() => {});

// ─── Constants ───────────────────────────────────────────────
const DEPOSIT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const SALT_ROUNDS = 10;

// ─── Schemas ─────────────────────────────────────────────────

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    created_at: { type: Date, default: Date.now }
});

const GopayAccountSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    phone: { type: String, required: true },
    access_token: { type: String, required: true },
    refresh_token: { type: String, default: '' },
    merchant_id: { type: String, default: '' },
    merchant_name: { type: String, default: '' },
    static_qr: { type: String, default: '' },
    linked_at: { type: Date, default: Date.now },
    token_updated_at: { type: Date, default: Date.now }
});

const DepositSchema = new mongoose.Schema({
    deposit_id: { type: String, required: true, unique: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    gopay_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GopayAccount', required: true },
    amount: { type: Number, required: true },
    qr_string: { type: String, required: true },
    status: { type: String, default: 'PENDING', enum: ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED'] },
    created_at: { type: Date, default: Date.now },
    expired_at: { type: Date, required: true },
    paid_at: { type: Date, default: null },
    cancelled_at: { type: Date, default: null },
    payment_data: { type: mongoose.Schema.Types.Mixed, default: null }
});

const ApiKeySchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, default: 'Default Key' },
    gopay_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GopayAccount' },
    created_at: { type: Date, default: Date.now },
    last_used: { type: Date, default: null }
});

// ─── Models ──────────────────────────────────────────────────

const User = mongoose.model('User', UserSchema);
const GopayAccount = mongoose.model('GopayAccount', GopayAccountSchema);
const Deposit = mongoose.model('Deposit', DepositSchema);
const ApiKey = mongoose.model('ApiKey', ApiKeySchema);

// ─── User Functions ──────────────────────────────────────────

async function createUser(username, password) {
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const user = new User({ username, password: hashed });
    await user.save();
    return { _id: user._id, username: user.username, created_at: user.created_at };
}

async function authenticateUser(username, password) {
    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user) return null;
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return null;
    return { _id: user._id, username: user.username, created_at: user.created_at };
}

async function getUserById(userId) {
    const user = await User.findById(userId).select('-password');
    return user ? user.toObject() : null;
}

async function userExists(username) {
    return !!(await User.findOne({ username: username.toLowerCase().trim() }));
}

// ─── GoPay Account Functions ─────────────────────────────────

async function linkGopayAccount({ user_id, phone, access_token, refresh_token, merchant_id, merchant_name }) {
    const account = await GopayAccount.findOneAndUpdate(
        { user_id, phone },
        {
            $set: {
                access_token,
                refresh_token: refresh_token || '',
                merchant_id: merchant_id || '',
                merchant_name: merchant_name || '',
                token_updated_at: new Date()
            },
            $setOnInsert: { linked_at: new Date() }
        },
        { upsert: true, new: true }
    );
    return account.toObject();
}

async function getGopayAccounts(user_id) {
    const accounts = await GopayAccount.find({ user_id });
    return accounts.map(a => a.toObject());
}

async function getGopayAccountById(accountId) {
    const account = await GopayAccount.findById(accountId);
    return account ? account.toObject() : null;
}

async function updateGopayAccount(accountId, updates) {
    const updated = await GopayAccount.findByIdAndUpdate(accountId, { $set: updates }, { new: true });
    return updated ? updated.toObject() : null;
}

async function deleteGopayAccount(accountId) {
    const result = await GopayAccount.deleteOne({ _id: accountId });
    return result.deletedCount > 0;
}

async function saveStaticQr(accountId, static_qr) {
    return updateGopayAccount(accountId, { static_qr });
}

// ─── Deposit Functions ───────────────────────────────────────

function generateDepositId() {
    return 'DEP-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function autoExpireDeposits() {
    await Deposit.updateMany(
        { status: 'PENDING', expired_at: { $lte: new Date() } },
        { $set: { status: 'EXPIRED' } }
    );
}

async function createDeposit({ user_id, gopay_account_id, amount, qr_string }) {
    await autoExpireDeposits();
    const now = new Date();
    const deposit = new Deposit({
        deposit_id: generateDepositId(),
        user_id,
        gopay_account_id,
        amount: parseInt(amount),
        qr_string,
        created_at: now,
        expired_at: new Date(now.getTime() + DEPOSIT_EXPIRY_MS)
    });
    await deposit.save();
    return deposit.toObject();
}

async function getDeposit(depositId) {
    await autoExpireDeposits();
    const deposit = await Deposit.findOne({ deposit_id: depositId });
    return deposit ? deposit.toObject() : null;
}

async function updateDeposit(depositId, updates) {
    const updated = await Deposit.findOneAndUpdate(
        { deposit_id: depositId },
        { $set: updates },
        { new: true }
    );
    return updated ? updated.toObject() : null;
}

async function cancelDeposit(depositId) {
    const deposit = await getDeposit(depositId);
    if (!deposit || deposit.status !== 'PENDING') return deposit;
    return updateDeposit(depositId, { status: 'CANCELLED', cancelled_at: new Date() });
}

async function listDeposits(user_id, { limit = 50, status = null } = {}) {
    await autoExpireDeposits();
    const filter = { user_id };
    if (status) filter.status = status.toUpperCase();
    const deposits = await Deposit.find(filter).sort({ created_at: -1 }).limit(Math.min(limit, 100));
    return deposits.map(d => d.toObject());
}

// ─── API Key Functions ───────────────────────────────────────

function generateApiKey() {
    return 'gm_' + crypto.randomBytes(24).toString('hex');
}

async function createApiKey({ user_id, name, gopay_account_id }) {
    const apiKey = new ApiKey({
        key: generateApiKey(),
        user_id,
        name: name || 'Default Key',
        gopay_account_id
    });
    await apiKey.save();
    return apiKey.toObject();
}

async function getApiKeyByKey(key) {
    const apiKey = await ApiKey.findOne({ key });
    return apiKey ? apiKey.toObject() : null;
}

async function listApiKeys(user_id) {
    const keys = await ApiKey.find({ user_id });
    return keys.map(k => k.toObject());
}

async function deleteApiKey(key) {
    return (await ApiKey.deleteOne({ key })).deletedCount > 0;
}

async function touchApiKey(key) {
    await ApiKey.findOneAndUpdate({ key }, { $set: { last_used: new Date() } });
}

// ─── Exports ─────────────────────────────────────────────────

module.exports = {
    connectDB,
    DEPOSIT_EXPIRY_MS,
    // User
    createUser, authenticateUser, getUserById, userExists,
    // GoPay Account
    linkGopayAccount, getGopayAccounts, getGopayAccountById,
    updateGopayAccount, deleteGopayAccount, saveStaticQr,
    // Deposit
    createDeposit, getDeposit, updateDeposit, cancelDeposit, listDeposits,
    // API Key
    createApiKey, getApiKeyByKey, listApiKeys, deleteApiKey, touchApiKey
};
