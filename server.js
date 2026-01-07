require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const paypal = require('@paypal/checkout-server-sdk');

const app = express();
const PORT = process.env.PORT || 3001;

// Conversion Rates
const COIN_RATE = parseFloat(process.env.COIN_RATE) || 1;
const MONEY_RATE = parseFloat(process.env.MONEY_RATE) || 1000000;

// ============================================
// DATABASE
// ============================================
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

pool.getConnection()
  .then(conn => {
    console.log('✅ Database connected');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  });

// ============================================
// PAYPAL
// ============================================
function payPalClient() {
  const environment = process.env.PAYPAL_MODE === 'production'
    ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
  return new paypal.core.PayPalHttpClient(environment);
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({ origin: process.env.ALLOWED_ORIGINS.split(',') }));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ============================================
// HELPERS
// ============================================
function calculateRewards(type, amountGEL) {
  if (type === 'coins') {
    return { coins: Math.floor(amountGEL * COIN_RATE), money: 0 };
  } else if (type === 'money') {
    return { coins: 0, money: Math.floor(amountGEL * MONEY_RATE) };
  }
  throw new Error('Invalid type');
}

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    rates: {
      coin: `1 GEL = ${COIN_RATE} Coin`,
      money: `1 GEL = ${MONEY_RATE.toLocaleString()} Money`
    }
  });
});

// Check if AID exists
app.post('/api/check-aid', async (req, res) => {
  try {
    const { aid } = req.body;
    
    if (!aid || isNaN(aid)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid AID format' 
      });
    }

    const aidNumber = parseInt(aid);

    // Check if AID is valid (100000-999999)
    if (aidNumber < 100000 || aidNumber > 999999) {
      return res.status(400).json({ 
        success: false, 
        error: 'AID must be between 100000-999999' 
      });
    }

    const [rows] = await pool.execute(
      'SELECT AID, username, coins, money FROM users WHERE AID = ?',
      [aidNumber]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'AID not found in database' 
      });
    }

    res.json({ 
      success: true,
      aid: rows[0].AID,
      username: rows[0].username,
      coins: rows[0].coins,
      money: rows[0].money
    });
  } catch (error) {
    console.error('Check AID error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Database error' 
    });
  }
});

// Create PayPal order
app.post('/api/create-order', async (req, res) => {
  try {
    const { aid, type, amount } = req.body;
    
    // Validate input
    if (!aid || !type || !amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: aid, type, amount' 
      });
    }

    if (type !== 'coins' && type !== 'money') {
      return res.status(400).json({ 
        success: false, 
        error: 'Type must be "coins" or "money"' 
      });
    }

    const amountGEL = parseFloat(amount);
    if (isNaN(amountGEL) || amountGEL < 1 || amountGEL > 1000) {
      return res.status(400).json({ 
        success: false, 
        error: 'Amount must be between 1-1000 GEL' 
      });
    }

    const aidNumber = parseInt(aid);

    // Check if AID exists
    const [accounts] = await pool.execute(
      'SELECT AID, username FROM users WHERE AID = ?',
      [aidNumber]
    );

    if (accounts.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'AID not found' 
      });
    }

    const username = accounts[0].username;
    const rewards = calculateRewards(type, amountGEL);
    
    // Create PayPal order
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'USD',
          value: amountGEL.toFixed(2)
        },
        description: type === 'coins' 
          ? `${rewards.coins} Coins for AID ${aidNumber}`
          : `${rewards.money.toLocaleString()} Money for AID ${aidNumber}`,
        custom_id: `${aidNumber}:${type}:${amountGEL}`
      }],
      application_context: {
        brand_name: 'PROJECT GENESIS',
        user_action: 'PAY_NOW'
      }
    });

    const order = await payPalClient().execute(request);
    
    console.log('✅ Order created:', {
      orderId: order.result.id,
      aid: aidNumber,
      username,
      type,
      amount: amountGEL,
      rewards
    });

    res.json({ 
      success: true, 
      orderId: order.result.id,
      rewards,
      username,
      description: type === 'coins'
        ? `${rewards.coins} Coins`
        : `${rewards.money.toLocaleString()} Game Money`
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to create order'
    });
  }
});

// Confirm payment
app.post('/api/confirm-payment', async (req, res) => {
  const conn = await pool.getConnection();
  
  try {
    await conn.beginTransaction();
    
    const { aid, type, amount, orderId } = req.body;

    if (!aid || !type || !amount || !orderId) {
      await conn.rollback();
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }

    const amountGEL = parseFloat(amount);
    const aidNumber = parseInt(aid);

    // Check duplicate
    const [existing] = await conn.execute(
      'SELECT id FROM donations WHERE order_id = ?',
      [orderId]
    );

    if (existing.length > 0) {
      await conn.rollback();
      console.warn('⚠️ Duplicate order:', orderId);
      return res.status(400).json({ 
        success: false, 
        error: 'Order already processed' 
      });
    }

    // Verify AID exists
    const [accounts] = await conn.execute(
      'SELECT AID FROM users WHERE AID = ?',
      [aidNumber]
    );

    if (accounts.length === 0) {
      await conn.rollback();
      return res.status(404).json({ 
        success: false, 
        error: 'AID not found' 
      });
    }

    // Capture PayPal payment
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    const capture = await payPalClient().execute(request);
    
    if (capture.result.status !== 'COMPLETED') {
      await conn.rollback();
      console.error('❌ Payment not completed:', capture.result.status);
      return res.status(400).json({ 
        success: false, 
        error: 'Payment not completed' 
      });
    }

    // Calculate rewards
    const rewards = calculateRewards(type, amountGEL);

    // Insert donation
    await conn.execute(
      `INSERT INTO donations 
       (aid, type, amount_gel, coins_reward, money_reward, order_id, processed) 
       VALUES (?, ?, ?, ?, ?, ?, FALSE)`,
      [aidNumber, type, amountGEL, rewards.coins, rewards.money, orderId]
    );

    await conn.commit();
    
    console.log('✅ Payment confirmed:', {
      aid: aidNumber,
      type,
      amount: amountGEL,
      orderId,
      rewards
    });

    res.json({ 
      success: true, 
      message: 'Donation processed successfully',
      rewards,
      description: type === 'coins'
        ? `You will receive ${rewards.coins} coins`
        : `You will receive ${rewards.money.toLocaleString()} game money`
    });

  } catch (error) {
    await conn.rollback();
    console.error('❌ Confirm payment error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process donation'
    });
  } finally {
    conn.release();
  }
});

// MTA: Get pending donations
app.post('/api/mta/pending', async (req, res) => {
  try {
    const { token } = req.body;

    if (token !== process.env.MTA_TOKEN) {
      console.warn('⚠️ Unauthorized MTA request');
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const [donations] = await pool.execute(
      `SELECT id, aid, type, coins_reward, money_reward, created_at 
       FROM donations 
       WHERE processed = FALSE 
       ORDER BY created_at ASC 
       LIMIT 50`
    );

    console.log(`📋 MTA requested pending: ${donations.length} found`);

    res.json({ 
      success: true, 
      donations,
      count: donations.length
    });
  } catch (error) {
    console.error('❌ Get pending error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// MTA: Mark as processed
app.post('/api/mta/mark-done', async (req, res) => {
  try {
    const { token, donationId, aid } = req.body;

    if (token !== process.env.MTA_TOKEN) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!donationId) {
      return res.status(400).json({ success: false, error: 'Missing donationId' });
    }

    // Get donation details
    const [donations] = await pool.execute(
      'SELECT aid, coins_reward, money_reward FROM donations WHERE id = ? AND processed = FALSE',
      [donationId]
    );

    if (donations.length === 0) {
      return res.status(404).json({ success: false, error: 'Donation not found' });
    }

    const donation = donations[0];

    // Update users table
    await pool.execute(
      'UPDATE users SET coins = coins + ?, money = money + ? WHERE AID = ?',
      [donation.coins_reward, donation.money_reward, donation.aid]
    );

    // Mark as processed
    await pool.execute(
      'UPDATE donations SET processed = TRUE, processed_at = NOW() WHERE id = ?',
      [donationId]
    );

    console.log('✅ Processed by MTA:', {
      donationId,
      aid: donation.aid,
      coins: donation.coins_reward,
      money: donation.money_reward
    });

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Mark done error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ MTA Donation Server (AID)');
  console.log(`📡 Port: ${PORT}`);
  console.log(`💰 1 GEL = ${COIN_RATE} Coin | ${MONEY_RATE.toLocaleString()} Money`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
