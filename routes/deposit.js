const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authenticateAdminToken } = require('../middleware/auth'); // <-- Import both
const jwt = require('jsonwebtoken'); // <-- Add jwt import
require('dotenv').config(); // <-- Add dotenv import

// --- Create deposit (user, supply screenshot URL, JWT protected) ---
// This route is correct.
router.post(
  '/',
  authenticateToken,
  async (req, res) => {
    const user_id = req.user.id;
    const { coin, amount, address, screenshot } = req.body; 

    if (!user_id || !coin || !amount || !address || !screenshot) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
      // --- NEW: Log values for debugging ---
      console.log("Attempting deposit with values:");
      console.log({ user_id, coin, amount, address, screenshot });
      // --- End new log ---

      const result = await pool.query(
        `INSERT INTO deposits (user_id, coin, amount, address, screenshot, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user_id, coin, amount, address, screenshot, 'pending']
      );
      res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
      console.error("DEPOSIT CREATE FAILED:", err);
      res.status(500).json({ error: 'Database error', detail: err.message }); // Added detail
    }
  }
);

// --- Get all deposits (SECURED for admin view or user view) ---
router.get('/', async (req, res) => {
  // --- Admin view (checks for x-admin-token) ---
  if (req.headers['x-admin-token'] && req.headers['x-admin-token'] === process.env.ADMIN_API_TOKEN) {
    try {
      const result = await pool.query('SELECT * FROM deposits ORDER BY created_at DESC');
      return res.json(result.rows);
    } catch (err) {
      return res.status(500).json({ error: 'Database error (admin)' });
    }
  }

  // --- User view (checks for JWT) ---
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'No token' });
    }
    let user_id = null;
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user_id = decoded.id || decoded.user_id;
    } catch (e) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    if (!user_id) return res.status(401).json({ error: "User not authenticated" });

    const result = await pool.query(
      'SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC',
      [user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error (user)' });
  }
});

// --- Admin: Approve/Reject deposit by id (SECURED + FIXED) ---
router.post(
  '/:id/status',
  authenticateAdminToken, // <-- 1. ADDED SECURITY
  async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    if (!["approved", "rejected"].includes(status)) { // Only allow approve/reject
      return res.status(400).json({ error: "Invalid status" });
    }

    const client = await pool.connect(); // Use a transaction

    try {
      const { rows } = await pool.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [id]);
      const deposit = rows[0];
      if (!deposit) return res.status(404).json({ error: "Deposit not found" });

      // --- 2. ADDED FIX: Check if already processed ---
      if (deposit.status === "approved" || deposit.status === "rejected") {
        return res.status(400).json({ error: `Deposit is already ${deposit.status}` });
      }

      await client.query('BEGIN'); // <-- 3. START TRANSACTION

      // Update deposit status first
      await client.query('UPDATE deposits SET status = $1 WHERE id = $2', [status, id]);

      // Only add balance if approving
      if (status === "approved") {
        // 1. Update user balance (insert or add)
        await client.query(
          `INSERT INTO user_balances (user_id, coin, balance)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, coin) DO UPDATE
           SET balance = user_balances.balance + EXCLUDED.balance`,
          [deposit.user_id, deposit.coin, deposit.amount]
        );

        // 2. Get the latest balance
        const { rows: balanceRows } = await client.query(
          `SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2`,
          [deposit.user_id, deposit.coin]
        );
        const newBalance = balanceRows[0] ? parseFloat(balanceRows[0].balance) : 0;

        // 3. Get latest USD price
        let price_usd = 1;
        if (deposit.coin !== "USDT") {
          const { rows: priceRows } = await client.query(
            `SELECT price_usd FROM prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1`,
            [deposit.coin]
          );
          price_usd = priceRows[0] ? parseFloat(priceRows[0].price_usd) : 1;
          if (!price_usd || isNaN(price_usd)) price_usd = 1;
        }

        // 4. Insert into balance_history
        await client.query(
          `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
           VALUES ($1, $2, $3, $4, NOW())`,
          [deposit.user_id, deposit.coin, newBalance, price_usd]
        );
      }

      await client.query('COMMIT'); // <-- 4. FINISH TRANSACTION
      res.json({ success: true, message: `Deposit ${id} ${status}` });

    } catch (err) {
      await client.query('ROLLBACK'); // <-- 5. UNDO CHANGES ON ERROR
      console.error("Deposit approve/reject error:", err);
      res.status(500).json({ error: 'Database error', detail: err.message });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
