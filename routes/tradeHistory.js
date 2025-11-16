// routes/tradehistory.js
const { authenticateToken } = require('../middleware/auth');
const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET all trades (global trade history, admin use)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM trades ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Failed to fetch trade history:', err.message);
    res.status(500).json({ error: 'Failed to fetch trade history' });
  }
});

module.exports = router;
