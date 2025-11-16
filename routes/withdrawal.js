require('dotenv').config();
const express = require('express');
const router = express.Router();
const pool = require('../db');
// --- 1. Import BOTH middlewares ---
const { authenticateToken, authenticateAdminToken } = require('../middleware/auth'); 
const jwt = require('jsonwebtoken');

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || 'yourSecureAdminTokenHere1234';

// --- User requests withdrawal (status = pending) ---
// This route is correct.
router.post('/', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  const { coin, amount, address, network } = req.body;
  if (!user_id || !coin || !amount || !address || !network) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = await pool.connect(); // Use transaction

  try {
    await client.query('BEGIN');

    // --- Check balance FOR UPDATE (locks the row) ---
    const { rows } = await client.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2 FOR UPDATE',
      [user_id, coin]
    );
    const userBal = rows[0];
    if (!userBal) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Balance record not found" });
    }
    if (parseFloat(userBal.balance) < parseFloat(amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // --- 1. Deduct balance first ---
    await client.query(
      'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3',
      [amount, user_id, coin]
    );

    // --- 2. Create withdrawal request ---
    const result = await client.query(
      `INSERT INTO withdrawals (user_id, coin, amount, address, status, network)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id`,
      [user_id, coin, amount, address, network]
    );

    await client.query('COMMIT');
    res.json({ success: true, id: result.rows[0].id });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Withdrawal request error:", err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// --- Get withdrawals (user: only own; admin: all) ---
// This route is correct.
router.get('/', async (req, res) => {
  // --- Admin view ---
  if (req.headers['x-admin-token'] && req.headers['x-admin-token'] === ADMIN_API_TOKEN) {
    try {
      const result = await pool.query(
        'SELECT * FROM withdrawals ORDER BY created_at DESC'
      );
      return res.json(result.rows);
    } catch (err) {
      return res.status(500).json({ error: 'Database error (admin)' });
    }
  }

  // --- User view ---
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
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error (user)' });
  }
});

// --- Approve/Reject withdrawal (admin) (SECURED + FIXED) ---
router.post(
  '/:id/status',
  authenticateAdminToken, // <-- 2. ADDED SECURITY
  async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const client = await pool.connect(); // Use transaction

  try {
    // Lock the withdrawal row
    const { rows } = await client.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    const withdrawal = rows[0];
    if (!withdrawal) return res.status(404).json({ error: "Withdrawal not found" });

    // --- 3. ADDED FIX: Check if already processed ---
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Withdrawal is already ${withdrawal.status}` });
    }

    await client.query('BEGIN');

    // Only update balance if REJECTING (refund the user)
    if (status === "rejected") {
      // Refund the balance that was deducted when they first made the request
      await client.query(
        `INSERT INTO user_balances (user_id, coin, balance)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, coin) DO UPDATE
         SET balance = user_balances.balance + EXCLUDED.balance`,
        [withdrawal.user_id, withdrawal.coin, withdrawal.amount]
      );
    }

    // If "approved", the money is already deducted. We just update the status.

    // Update the withdrawal status
    await client.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);

    await client.query('COMMIT');
    res.json({ success: true, message: `Withdrawal ${id} ${status}` });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Withdrawal approve/reject error:", err);
    res.status(500).json({ error: "Database error", detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
