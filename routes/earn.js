// routes/earn.js

const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// Helper function to get current price
async function getCoinPriceUSD(coin) {
  if (coin === "USDT" || coin === "USDC") return 1;
  
  try {
    const priceRes = await pool.query(
      "SELECT price_usd FROM prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1",
      [coin]
    );
    if (priceRes.rows[0]) return parseFloat(priceRes.rows[0].price_usd);
    
    const apiMap = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'XRP': 'ripple', 'TON': 'toncoin', 'BNB': 'binancecoin' };
    const apiSymbol = apiMap[coin];
    
    if (apiSymbol) {
      const priceApiRes = await axios.get(
        `${process.env.MAIN_API_BASE || 'http://localhost:5000'}/api/prices/${apiSymbol}`,
        { timeout: 5000 }
      );
      const priceUSD = priceApiRes.data.price;
      
      await pool.query(
        `INSERT INTO prices (symbol, price_usd, updated_at) VALUES ($1, $2, NOW()) 
         ON CONFLICT (symbol) DO UPDATE SET price_usd = $2, updated_at = NOW()`,
        [coin, priceUSD]
      );
      return priceUSD;
    }
    
    const defaults = { BTC: 60000, ETH: 3000, BNB: 600, SOL: 150, XRP: 0.5, TON: 5 };
    return defaults[coin] || 1;
  } catch (error) {
    console.error(`Price fetch error for ${coin}:`, error.message);
    const defaults = { BTC: 60000, ETH: 3000, BNB: 600, SOL: 150, XRP: 0.5, TON: 5 };
    return defaults[coin] || 1;
  }
}

// ---
// GET /api/earn/balance
// Fetch only USDT for the mining dashboard
// ---
router.get('/balance', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      "SELECT coin, balance FROM earn_wallet WHERE user_id = $1 AND balance > 0 AND coin = 'USDT'",
      [userId]
    );
    res.json({ assets: rows });
  } catch (error) {
    console.error("Error fetching mining balance:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ---
// POST /api/earn/deposit
// Deduct chosen asset -> Auto-convert -> Credit USDT to Mining Wallet
// ---
router.post('/deposit', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { coin, amount } = req.body;
  const depositAmount = parseFloat(amount);

  if (!coin || isNaN(depositAmount) || depositAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid coin or amount." });
  }

  const priceUSD = await getCoinPriceUSD(coin);
  const usdtEquivalent = depositAmount * priceUSD;
  
  // Tier 1 minimum is $50
  if (usdtEquivalent < 50) {
    return res.status(400).json({ 
      success: false, 
      error: `Minimum allocation is $50. Your deposit is worth $${usdtEquivalent.toFixed(2)}.` 
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check main wallet balance
    const balanceRes = await client.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentBalance = parseFloat(balanceRes.rows[0]?.balance || 0);
    if (currentBalance < depositAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Insufficient funds in Spot Wallet." });
    }

    // 2. Subtract original asset from Spot wallet
    await client.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [depositAmount, userId, coin]
    );

    // 3. Add USDT equivalent to Mining wallet (Auto-Convert)
    await client.query(
      `INSERT INTO earn_wallet (user_id, coin, balance) 
       VALUES ($1, 'USDT', $2) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = earn_wallet.balance + $2`,
      [userId, usdtEquivalent]
    );

    await client.query('COMMIT');
    res.json({ 
      success: true,
      message: `Successfully allocated ${depositAmount} ${coin} (≈ $${usdtEquivalent.toFixed(2)} USDT) to AI Mining.`,
      usd_value: usdtEquivalent
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error in mining deposit:", error);
    res.status(500).json({ success: false, error: "Allocation failed. Please try again." });
  } finally {
    client.release();
  }
});

// ---
// POST /api/earn/withdraw
// Withdraw USDT back to Spot Wallet
// ---
router.post('/withdraw', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  // Always withdraw as USDT
  const coin = 'USDT'; 
  const { amount } = req.body;
  const withdrawAmount = parseFloat(amount);

  if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid amount." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check mining wallet balance
    const earnRes = await client.query(
      "SELECT balance FROM earn_wallet WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentEarnBalance = parseFloat(earnRes.rows[0]?.balance || 0);
    if (currentEarnBalance < withdrawAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Insufficient deployed capital." });
    }

    // 2. Subtract from Mining wallet
    await client.query(
      "UPDATE earn_wallet SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [withdrawAmount, userId, coin]
    );

    // 3. Add USDT back to Spot wallet
    await client.query(
      `INSERT INTO user_balances (user_id, coin, balance) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = user_balances.balance + $3`,
      [userId, coin, withdrawAmount]
    );

    await client.query('COMMIT');
    res.json({ 
      success: true, 
      message: `Successfully withdrew $${withdrawAmount.toFixed(2)} USDT back to Spot Wallet.`
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error in mining withdraw:", error);
    res.status(500).json({ success: false, error: "Withdrawal failed. Please try again." });
  } finally {
    client.release();
  }
});

// ---
// GET /api/earn/transactions (Optional Log)
// ---
router.get('/transactions', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const tableCheck = await pool.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'earn_transactions')`);
    if (!tableCheck.rows[0].exists) return res.json({ transactions: [] });
    
    const { rows } = await pool.query("SELECT * FROM earn_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [userId]);
    res.json({ transactions: rows });
  } catch (error) {
    res.json({ transactions: [] });
  }
});

module.exports = router;
