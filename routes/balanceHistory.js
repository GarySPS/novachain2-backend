// routes/balanceHistory.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// GET /api/balance/history (JWT-protected, returns user's total USD balance per day)
router.get('/', authenticateToken, async (req, res) => {
  try {
    // Each row is: { date: 'YYYY-MM-DD', total_usd: 1234.56 }
    const { rows } = await pool.query(`
      SELECT 
        TO_CHAR(DATE(timestamp), 'YYYY-MM-DD') as date, 
        ROUND(SUM(balance * price_usd), 2) as total_usd
      FROM balance_history
      WHERE user_id = $1
      GROUP BY date
      ORDER BY date ASC
      LIMIT 30;
    `, [req.user.id]);
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
