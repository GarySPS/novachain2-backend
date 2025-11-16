require('dotenv').config();
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authenticateAdminToken } = require('../middleware/auth'); 
const jwt = require('jsonwebtoken');

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || 'yourSecureAdminTokenHere1234';

// --- User requests withdrawal (status = pending) ---
// SIMPLE VERSION: No transaction, no deduction.
router.post('/', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  // 1. REMOVED 'network'
  const { coin, amount, address } = req.body;
  
  // 2. REMOVED 'network' from check
  if (!user_id || !coin || !amount || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 3. REMOVED transaction. Just check balance.
  try {
    const { rows } = await pool.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
      [user_id, coin]
    );
    const userBal = rows[0];
    if (!userBal) {
      return res.status(400).json({ error: "Balance record not found" });
    }
    if (parseFloat(userBal.balance) < parseFloat(amount)) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // 4. REMOVED deduction. Just INSERT.
    // 5. REMOVED 'network' from INSERT.
    const result = await pool.query(
      `INSERT INTO withdrawals (user_id, coin, amount, address, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [user_id, coin, amount, address] // 4 values
    );

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error("Withdrawal request error:", err);
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Get withdrawals (user: only own; admin: all) ---
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
// THIS NOW CONTAINS THE DEDUCTION LOGIC
router.post(
  '/:id/status',
  authenticateAdminToken, 
  async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const client = await pool.connect(); // Use transaction for admin logic

  try {
    await client.query('BEGIN');
    
    // Get the withdrawal request and lock it
    const { rows } = await client.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    const withdrawal = rows[0];

    if (!withdrawal) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "Withdrawal not found" });
    }

    // Check if already processed
    if (withdrawal.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Withdrawal is already ${withdrawal.status}` });
    }

    // --- THIS IS THE NEW LOGIC ---
    if (status === "approved") {
      // 1. Get current balance
      const { rows: balRows } = await client.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const userBal = balRows[0];
      
      // 2. Check if balance is sufficient
      if (!userBal || parseFloat(userBal.balance) < parseFloat(withdrawal.amount)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: "Insufficient balance to approve" });
      }
      
      // 3. Deduct balance
      await client.query(
        'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );
      
    } else if (status === "rejected") {
      // Do nothing. The money was never taken.
    }

    // 4. Update the withdrawal status
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
