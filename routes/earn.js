//routes>earn.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// ---
// GET /api/earn/balance
// Fetches the user's savings wallet balances
// ---
router.get('/balance', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await pool.query(
      "SELECT coin as symbol, balance FROM earn_wallet WHERE user_id = $1 AND balance > 0",
      [userId]
    );
    
    res.json({ assets: rows });
  } catch (error) {
    console.error("Error fetching earn balance:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ---
// POST /api/earn/deposit (Save)
// Moves funds from the main 'user_balances' wallet to the 'earn_wallet'
// MINIMUM DEPOSIT: $3,000 USD equivalent
// ---
router.post('/deposit', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { coin, amount } = req.body;
  const depositAmount = parseFloat(amount);

  // Basic validation
  if (!coin || isNaN(depositAmount) || depositAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid coin or amount." });
  }

  // 🔴 NEW: Minimum deposit validation ($3,000 USD equivalent)
  // Get current price of the coin to check USD value
  let priceUSD = 1; // Default for USDT
  if (coin !== "USDT") {
    try {
      const priceRes = await pool.query(
        "SELECT price_usd FROM prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1",
        [coin]
      );
      priceUSD = priceRes.rows[0] ? parseFloat(priceRes.rows[0].price_usd) : 1;
    } catch (err) {
      console.error("Error fetching price:", err);
      priceUSD = 1;
    }
  }
  
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

    // 1. Check if user has enough in their MAIN wallet (user_balances)
    const balanceRes = await client.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentBalance = parseFloat(balanceRes.rows[0]?.balance || 0);
    if (currentBalance < depositAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Insufficient funds in main wallet." });
    }

    // 2. Subtract from MAIN wallet (user_balances)
    const updateResult = await client.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3 RETURNING balance",
      [depositAmount, userId, coin]
    );

    // 3. Add to EARN wallet
    await client.query(
      `INSERT INTO earn_wallet (user_id, coin, balance) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = earn_wallet.balance + $3`,
      [userId, coin, depositAmount]
    );

    // 4. OPTIONAL: Log the transaction for audit trail
    await client.query(
      `INSERT INTO earn_transactions (user_id, coin, amount, type, usd_value, status, created_at)
       VALUES ($1, $2, $3, 'deposit', $4, 'completed', NOW())`,
      [userId, coin, depositAmount, usdValue]
    );

    await client.query('COMMIT');
    
    // Return success with updated balances
    res.json({ 
      success: true,
      message: `Successfully deposited ${depositAmount} ${coin} to savings`,
      usd_value: usdValue
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error in earn deposit transaction:", error);
    res.status(500).json({ success: false, error: "Transaction failed. Please try again." });
  } finally {
    client.release();
  }
});

// ---
// POST /api/earn/withdraw (Redeem)
// Moves funds from the 'earn_wallet' back to the main 'user_balances' wallet
// ---
router.post('/withdraw', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { coin, amount } = req.body;
  const redeemAmount = parseFloat(amount);

  if (!coin || isNaN(redeemAmount) || redeemAmount <= 0) {
    return res.status(400).json({ success: false, error: "Invalid coin or amount." });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Check if user has enough in their EARN wallet
    const earnRes = await client.query(
      "SELECT balance FROM earn_wallet WHERE user_id = $1 AND coin = $2 FOR UPDATE",
      [userId, coin]
    );

    const currentEarnBalance = parseFloat(earnRes.rows[0]?.balance || 0);
    if (currentEarnBalance < redeemAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: "Insufficient funds in savings." });
    }

    // 2. Subtract from EARN wallet
    await client.query(
      "UPDATE earn_wallet SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [redeemAmount, userId, coin]
    );

    // 3. Add to MAIN wallet (user_balances)
    await client.query(
      `INSERT INTO user_balances (user_id, coin, balance) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user_id, coin) 
       DO UPDATE SET balance = user_balances.balance + $3`,
      [userId, coin, redeemAmount]
    );

    // 4. OPTIONAL: Log the transaction
    await client.query(
      `INSERT INTO earn_transactions (user_id, coin, amount, type, status, created_at)
       VALUES ($1, $2, $3, 'withdraw', 'completed', NOW())`,
      [userId, coin, redeemAmount]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `Successfully withdrew ${redeemAmount} ${coin} from savings` });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error in earn withdraw transaction:", error);
    res.status(500).json({ success: false, error: "Transaction failed. Please try again." });
  } finally {
    client.release();
  }
});

// ---
// OPTIONAL: GET /api/earn/transactions
// Fetches user's earn transaction history
// ---
router.get('/transactions', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
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
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;