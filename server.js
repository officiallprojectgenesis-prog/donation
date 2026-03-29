require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3001;

const COIN_RATE    = parseFloat(process.env.COIN_RATE)  || 1;
const MONEY_RATE   = parseFloat(process.env.MONEY_RATE) || 1_000_000;
const ALLOWED_AMOUNTS = [5, 10, 20, 50, 100];

// ============================================
// DATABASE
// ============================================
const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

pool.getConnection()
  .then(conn => { console.log('✅ Database connected'); conn.release(); })
  .catch(err  => { console.error('❌ Database connection failed:', err.message); process.exit(1); });

// ============================================
// MIDDLEWARE
// ============================================
const allowedOrigins = [
  'https://genesis-official.duckdns.org',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    console.warn('⚠️ Blocked by CORS:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// HELPERS
// ============================================
function calculateRewards(type, amountGEL) {
  if (type === 'coins') return { coins: Math.floor(amountGEL * COIN_RATE), money: 0 };
  if (type === 'money') return { coins: 0, money: Math.floor(amountGEL * MONEY_RATE) };
  throw new Error('Invalid type');
}

// ============================================
// DB MIGRATION — status column
// ============================================
async function ensureStatusColumn() {
  try {
    await pool.execute(
      "ALTER TABLE donations ADD COLUMN IF NOT EXISTS status ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid'"
    );
    console.log('✅ donations.status column ready');
  } catch (_) {
    console.log('ℹ️ status column check done');
  }
}
ensureStatusColumn();

// ============================================
// ENDPOINTS
// ============================================

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Check AID ──────────────────────────────────────────────────
app.post('/api/check-aid', async (req, res) => {
  try {
    const { aid } = req.body;
    if (!aid || isNaN(aid))
      return res.status(400).json({ success: false, error: 'Invalid AID format' });

    const aidNumber = parseInt(aid);
    if (aidNumber < 100000 || aidNumber > 999999)
      return res.status(400).json({ success: false, error: 'AID must be between 100000-999999' });

    const [rows] = await pool.execute(
      'SELECT AID, username FROM users WHERE AID = ?', [aidNumber]
    );
    if (rows.length === 0)
      return res.status(404).json({ success: false, error: 'AID not found in database' });

    res.json({ success: true, aid: rows[0].AID, username: rows[0].username });
  } catch (err) {
    console.error('Check AID error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ── Register UNPAID donation (before Keepz redirect) ──────────
// status='unpaid' — MTA არ ამუშავებს სანამ ადმინი არ დაადასტურებს
app.post('/api/register-pending', async (req, res) => {
  try {
    const { aid, type, amountGEL } = req.body;

    if (!aid || !type || !amountGEL)
      return res.status(400).json({ success: false, error: 'Missing fields' });

    if (type !== 'coins' && type !== 'money')
      return res.status(400).json({ success: false, error: 'type must be coins or money' });

    const gelAmount = parseFloat(amountGEL);
    if (!ALLOWED_AMOUNTS.includes(gelAmount))
      return res.status(400).json({ success: false, error: `amountGEL must be one of: ${ALLOWED_AMOUNTS.join(', ')}` });

    const aidNumber = parseInt(aid);
    const [accounts] = await pool.execute('SELECT AID, username FROM users WHERE AID = ?', [aidNumber]);
    if (accounts.length === 0)
      return res.status(404).json({ success: false, error: 'AID not found' });

    const rewards = calculateRewards(type, gelAmount);

    await pool.execute(
      `INSERT INTO donations (aid, type, amount_gel, coins_reward, money_reward, order_id, processed, status)
       VALUES (?, ?, ?, ?, ?, ?, FALSE, 'unpaid')`,
      [aidNumber, type, gelAmount, rewards.coins, rewards.money, `KEEPZ-${Date.now()}`]
    );

    console.log('📝 Unpaid registered:', { aid: aidNumber, username: accounts[0].username, type, gelAmount });
    res.json({ success: true, rewards });
  } catch (err) {
    console.error('Register pending error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ── Admin: list unpaid donations ──────────────────────────────
app.post('/api/admin/unpaid', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ success: false, error: 'Unauthorized' });

    const [donations] = await pool.execute(
      `SELECT d.id, d.aid, u.username, d.type, d.amount_gel, d.coins_reward, d.money_reward, d.created_at
       FROM donations d
       LEFT JOIN users u ON d.aid = u.AID
       WHERE d.status = 'unpaid' AND d.processed = FALSE
       ORDER BY d.created_at DESC LIMIT 100`
    );

    res.json({ success: true, donations });
  } catch (err) {
    console.error('Admin unpaid error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ── Admin: confirm payment → unpaid becomes paid ──────────────
app.post('/api/admin/confirm-payment', async (req, res) => {
  try {
    const { token, donationId } = req.body;
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ success: false, error: 'Unauthorized' });

    if (!donationId)
      return res.status(400).json({ success: false, error: 'Missing donationId' });

    const [rows] = await pool.execute(
      "SELECT id FROM donations WHERE id = ? AND status = 'unpaid'", [donationId]
    );
    if (rows.length === 0)
      return res.status(404).json({ success: false, error: 'Not found or already confirmed' });

    await pool.execute("UPDATE donations SET status = 'paid' WHERE id = ?", [donationId]);

    console.log('✅ Admin confirmed #', donationId);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin confirm error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ── Admin: reject unpaid donation ─────────────────────────────
app.post('/api/admin/reject-payment', async (req, res) => {
  try {
    const { token, donationId } = req.body;
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ success: false, error: 'Unauthorized' });

    await pool.execute("DELETE FROM donations WHERE id = ? AND status = 'unpaid'", [donationId]);

    console.log('🗑️ Admin rejected #', donationId);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin reject error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ── MTA: Get pending (მხოლოდ paid status) ─────────────────────
app.post('/api/mta/pending', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || token !== process.env.MTA_TOKEN)
      return res.status(401).json({ success: false, error: 'Unauthorized' });

    const [donations] = await pool.execute(
      `SELECT id, aid, type, coins_reward, money_reward, created_at
       FROM donations
       WHERE processed = FALSE AND status = 'paid'
       ORDER BY created_at ASC LIMIT 50`
    );

    console.log(`📋 MTA requested pending: ${donations.length} found`);
    res.json({ success: true, donations, count: donations.length });
  } catch (err) {
    console.error('Get pending error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ── MTA: Mark as processed ────────────────────────────────────
app.post('/api/mta/mark-done', async (req, res) => {
  try {
    const { token, donationId } = req.body;
    if (!token || token !== process.env.MTA_TOKEN)
      return res.status(401).json({ success: false, error: 'Unauthorized' });

    if (!donationId)
      return res.status(400).json({ success: false, error: 'Missing donationId' });

    const [donations] = await pool.execute(
      "SELECT aid, coins_reward, money_reward FROM donations WHERE id = ? AND processed = FALSE AND status = 'paid'",
      [donationId]
    );
    if (donations.length === 0)
      return res.status(404).json({ success: false, error: 'Not found or already processed' });

    const d = donations[0];
    await pool.execute(
      'UPDATE users SET coins = coins + ?, money = money + ? WHERE AID = ?',
      [d.coins_reward, d.money_reward, d.aid]
    );
    await pool.execute(
      'UPDATE donations SET processed = TRUE, processed_at = NOW() WHERE id = ?', [donationId]
    );

    console.log('✅ Processed by MTA:', { donationId, aid: d.aid });
    res.json({ success: true });
  } catch (err) {
    console.error('Mark done error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ MTA Donation Server (Keepz)');
  console.log(`📡 Port: ${PORT}`);
  console.log(`💰 1 GEL = ${COIN_RATE} Coin | ${MONEY_RATE.toLocaleString()} Money`);
  console.log(`📦 Allowed: ${ALLOWED_AMOUNTS.join(', ')} GEL`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
