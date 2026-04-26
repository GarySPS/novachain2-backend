// routes/earn.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// Helper function to get current price with fallbacks
async function getCoinPriceUSD(coin) {
  if (coin === "USDT") return 1;
  
  try {
    // Try to get from prices table
    const priceRes = await pool.query(
      "SELECT price_usd FROM prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1",
      [coin]
    );
    
    if (priceRes.rows[0]) {
      return parseFloat(priceRes.rows[0].price_usd);
    }
    
    // Fallback: Fetch from your price API
    const apiMap = {
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
      'SOL': 'solana', 
      'XRP': 'ripple',
      'TON': 'toncoin'
    };
    
    const apiSymbol = apiMap[coin];
    if (apiSymbol) {
      const priceApiRes = await axios.get(
        `${process.env.MAIN_API_BASE || 'http://localhost:5000'}/api/prices/${apiSymbol}`,
        { timeout: 5000 }
      );
      
      const priceUSD = priceApiRes.data.price;
      
      // Cache in prices table for next time
      await pool.query(
        `INSERT INTO prices (symbol, price_usd, updated_at) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (symbol) 
         DO UPDATE SET price_usd = $2, updated_at = NOW()`,
        [coin, priceUSD]
      );
      
      return priceUSD;
    }
    
    // Last resort: reasonable defaults
    const defaults = { BTC: 50000, ETH: 3000, SOL: 150, XRP: 0.5, TON: 5 };
    return defaults[coin] || 1;
    
  } catch (error) {
    console.error(`Price fetch error for ${coin}:`, error.message);
    const defaults = { BTC: 50000, ETH: 3000, SOL: 150, XRP: 0.5, TON: 5 };
    return defaults[coin] || 1;
  }
}

// Helper to calculate interest (5% APY)
function calculateInterest(usdAmount, days = 30) {
  const APY = 0.05;
  return usdAmount * APY * (days / 365);
}

// ---
// GET /api/earn/balance
// ---
router.get('/balance', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await pool.query(
      "SELECT coin, balance FROM earn_wallet WHERE user_id = $1 AND balance > 0",
      [userId]
    );
    
    const assetsWithInterest = await Promise.all(rows.map(async (asset) => {
      const priceUSD = await getCoinPriceUSD(asset.coin);
      const usdValue = parseFloat(asset.balance) * priceUSD;
      const estimatedInterest = calculateInterest(usdValue, 30);
      
      return {
        symbol: asset.coin,
        balance: asset.balance,
        usd_value: usdValue,
        estimated_interest_30d: estimatedInterest,
        price_usd: priceUSD
      };
    }));
    
    res.json({ assets: assetsWithInterest });
  } catch (error) {
    console.error("Error fetching earn balance:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ---
// POST /api/earn/deposit
// ---
router.post('/deposit', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { coin, amount } = req.body;
  const depositAmount = parseFloat(amount);

  if (!coin || isNaN(depositAmount) || depositAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid coin or amount." });
  }

  const priceUSD = await getCoinPriceUSD(coin);
  const usdValue = depositAmount * priceUSD;
  
  if (usdValue < 3000) {
    return res.status(400).json({ 
      success: false, 
      error: `Minimum deposit is $3,000 USD equivalent. Your deposit is worth $${usdValue.toFixed(2)} USD.` 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check main wallet balance
    const balanceRes = await client.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentBalance = parseFloat(balanceRes.rows[0]?.balance || 0);
    if (currentBalance < depositAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Insufficient funds in main wallet." });
    }

    // Subtract from main wallet
    await client.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [depositAmount, userId, coin]
    );

    // Add to earn wallet (using your existing table structure)
    await client.query(
      `INSERT INTO earn_wallet (user_id, coin, balance) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = earn_wallet.balance + $3`,
      [userId, coin, depositAmount]
    );

    // Log transaction (create earn_transactions table if you want this)
    await client.query(
      `INSERT INTO earn_transactions (user_id, coin, amount, type, usd_value, status, created_at)
       VALUES ($1, $2, $3, 'deposit', $4, 'completed', NOW())`,
      [userId, coin, depositAmount, usdValue]
    );

    await client.query('COMMIT');
    
    res.json({ 
      success: true,
      message: `Successfully deposited ${depositAmount} ${coin} to savings`,
      usd_value: usdValue
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error in earn deposit:", error);
    res.status(500).json({ success: false, error: "Transaction failed. Please try again." });
  } finally {
    client.release();
  }
});

// ---
// POST /api/earn/withdraw
// ---
router.post('/withdraw', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { coin, amount } = req.body;
  const redeemAmount = parseFloat(amount);

  if (!coin || isNaN(redeemAmount) || redeemAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid coin or amount." });
  }

  const priceUSD = await getCoinPriceUSD(coin);
  const usdValue = redeemAmount * priceUSD;
  
  if (usdValue < 100) {
    return res.status(400).json({ 
      success: false, 
      error: `Minimum withdrawal is $100 USD equivalent. Your withdrawal is worth $${usdValue.toFixed(2)} USD.` 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check earn wallet balance
    const earnRes = await client.query(
      "SELECT balance FROM earn_wallet WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentEarnBalance = parseFloat(earnRes.rows[0]?.balance || 0);
    if (currentEarnBalance < redeemAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Insufficient funds in savings." });
    }

    // Subtract from earn wallet
    await client.query(
      "UPDATE earn_wallet SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [redeemAmount, userId, coin]
    );

    // Add to main wallet
    await client.query(
      `INSERT INTO user_balances (user_id, coin, balance) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = user_balances.balance + $3`,
      [userId, coin, redeemAmount]
    );

    // Log transaction
    await client.query(
      `INSERT INTO earn_transactions (user_id, coin, amount, type, usd_value, status, created_at)
       VALUES ($1, $2, $3, 'withdraw', $4, 'completed', NOW())`,
      [userId, coin, redeemAmount, usdValue]
    );

    await client.query('COMMIT');
    
    res.json({ 
      success: true, 
      message: `Successfully withdrew ${redeemAmount} ${coin} from savings`
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error in earn withdraw:", error);
    res.status(500).json({ success: false, error: "Transaction failed. Please try again." });
  } finally {
    client.release();
  }
});

// ---
// GET /api/earn/transactions
// ---
router.get('/transactions', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
    // Check if earn_transactions table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'earn_transactions'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({ transactions: [] });
    }
    
    const { rows } = await pool.query(
      `SELECT * FROM earn_transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [userId]
    );
    res.json({ transactions: rows });
  } catch (error) {
    console.error("Error fetching earn transactions:", error);
    res.json({ transactions: [] });
  }
});

module.exports = router;