//server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const pool = require('./db');
const axios = require('axios');
const cron = require('node-cron');

// JWT Middleware
const { authenticateToken, authenticateAdminToken } = require('./middleware/auth');

// ROUTES
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const tradeRoutes = require('./routes/trade');
const pricesRoutes = require('./routes/prices');      
const depositRoutes = require('./routes/deposit');
const withdrawalRoutes = require('./routes/withdrawal');
const kycRoutes = require('./routes/kyc');
const profileRoutes = require('./routes/profile');    
const balanceRoutes = require('./routes/balance');
const convertRoutes = require('./routes/convert');
const balanceHistoryRoutes = require('./routes/balanceHistory');
const userRoutes = require('./routes/user');
const uploadRoute = require('./routes/upload');
const earnRoutes = require('./routes/earn');

const app = express();

const allowedOrigins = [
  'http://localhost:3000',
  'https://www.novachain.digital',
  'https://novachain2-frontend.vercel.app',
  'https://novachain.digital',
  'https://novachain2-backend.onrender.com',
  'https://novachainofficial.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json());
app.use('/api/balance/history', balanceHistoryRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoute);

// --- Multer upload config ---
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, "_");
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

app.get(
  '/api/admin/deposit-addresses',
  authenticateAdminToken,
  async (req, res) => {
    try {
      const result = await pool.query(`SELECT coin, address, qr_url FROM deposit_addresses`);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch deposit addresses" });
    }
  }
);

// --- NEW: Admin-only route to SAVE deposit settings ---
app.post(
  '/api/admin/deposit-addresses',
  authenticateAdminToken,
  async (req, res) => {
    const wallets = req.body; // This is an array: [{ coin: 'USDT', ... }, ...]
    if (!Array.isArray(wallets)) {
      return res.status(400).json({ success: false, message: "Invalid payload. Expected an array." });
    }

    const client = await pool.connect(); // Use a transaction for all-or-nothing
    try {
      await client.query('BEGIN');
      
      for (const wallet of wallets) {
        // Use "INSERT ... ON CONFLICT" (UPSERT)
        await client.query(
          `
            INSERT INTO deposit_addresses (coin, address, qr_url, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (coin)
            DO UPDATE SET 
              address = EXCLUDED.address, 
              qr_url = EXCLUDED.qr_url, 
              updated_at = NOW()
            `,
            // We are only passing 3 values, NOW() is a SQL function
            [wallet.coin, wallet.address, wallet.qr_url]
        );
      }
      
      await client.query('COMMIT');
      res.json({ success: true, message: "Deposit wallet settings updated" });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error("ADMIN DEPOSIT SAVE ERROR:", err); // <-- THIS IS THE IMPORTANT LINE
      res.status(500).json({ success: false, message: "Failed to save deposit settings", detail: err.message });
    } finally {
      client.release();
    }
  }
);

// --------- ROUTE MOUNTING ---------
app.use('/api/admin', adminRoutes);
app.use('/api/trade', tradeRoutes);
app.use('/api/prices', pricesRoutes);
app.use('/api/price', pricesRoutes);
app.use('/api/deposit', depositRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/withdraw', withdrawalRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/balance', balanceRoutes);
app.use('/api/convert', convertRoutes);     
app.use('/api/users', userRoutes);
app.use('/api/earn', earnRoutes);

// --------- BASIC ROOT CHECK ---------
app.get("/", (req, res) => {
  res.send("NovaChain API is running.");
});

// --- Fetch deposit addresses for user deposit modal (public, no auth needed) ---
app.get('/api/public/deposit-addresses', async (req, res) => { // <-- Renamed route
  try {
    const result = await pool.query(
      // Only send coins that have an address set
      `SELECT coin, address, qr_url FROM deposit_addresses WHERE address IS NOT NULL AND address != ''`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch deposit addresses" });
  }
});

// --- ADMIN: Fetch ALL trades for admin backend ---
app.get('/api/trades', async (req, res) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM trades ORDER BY timestamp DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Catch-all for unknown API routes
app.use((req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// --------- START SERVER ---------
const PORT = process.env.PORT || 5000;

// =====================================================================
// AI ETH MINING: AUTOMATED WEEKLY PAYOUT ENGINE (11 TIERS)
// =====================================================================

// Helper to determine weekly yield percentage based on deployed capital
function getMiningWeeklyRate(amount) {
  if (amount >= 500000) return 0.25; // Tier X: 25%
  if (amount >= 200000) return 0.20; // Tier 10: 20%
  if (amount >= 100000) return 0.18; // Tier 9: 18%
  if (amount >= 50000)  return 0.16; // Tier 8: 16%
  if (amount >= 20000)  return 0.14; // Tier 7: 14%
  if (amount >= 15000)  return 0.12; // Tier 6: 12%
  if (amount >= 10000)  return 0.09; // Tier 5: 9%
  if (amount >= 5000)   return 0.07; // Tier 4: 7%
  if (amount >= 1000)   return 0.05; // Tier 3: 5%
  if (amount >= 500)    return 0.03; // Tier 2: 3%
  if (amount >= 50)     return 0.02; // Tier 1: 2%
  return 0;
}

// Runs every Sunday at Midnight (00:00) server time
cron.schedule('0 0 * * 0', async () => {
  console.log("⚡ [AI MINING] Initiating weekly yield distributions...");
  
  try {
    // 1. Fetch all users with active mining capital in USDT (min $50)
    const { rows } = await pool.query(
      "SELECT user_id, balance FROM earn_wallet WHERE coin = 'USDT' AND balance >= 50"
    );

    let payoutsCount = 0;
    let totalYieldDistributed = 0;

    for (const miner of rows) {
      const capital = parseFloat(miner.balance || 0);
      const weeklyRate = getMiningWeeklyRate(capital);

      if (weeklyRate > 0) {
        const yieldAmount = capital * weeklyRate;

        // 2. Drop the weekly profit directly into the user's Spot Wallet
        await pool.query(
          `INSERT INTO user_balances (user_id, coin, balance) 
           VALUES ($1, 'USDT', $2) 
           ON CONFLICT (user_id, coin) 
           DO UPDATE SET balance = user_balances.balance + $2`,
          [miner.user_id, yieldAmount]
        );

        // 3. Log the payout in transaction history
        await pool.query(
          `INSERT INTO earn_transactions (user_id, coin, amount, type, usd_value, status, created_at)
           VALUES ($1, 'USDT', $2, 'mining_payout', $2, 'completed', NOW())`,
          [miner.user_id, yieldAmount]
        ).catch(() => {}); // Skips cleanly if table is not used

        payoutsCount++;
        totalYieldDistributed += yieldAmount;
      }
    }

    console.log(`✅ [AI MINING] Completed: Distributed $${totalYieldDistributed.toFixed(2)} USDT yield across ${payoutsCount} active miners.`);
  } catch (error) {
    console.error("❌ [AI MINING] Weekly payout error:", error.message);
  }
});
// =====================================================================

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
