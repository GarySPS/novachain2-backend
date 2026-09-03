// routes/agent.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// Agent dashboard: Get all referred users and their balances
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    // The agent logs in just like a normal user. 
    // We use their own username as their unique Agent Code.
    const agentCode = req.user.username; 

    // Find all users where member_code matches this Agent's username
    const { rows: referredUsers } = await pool.query(
     `SELECT id, username, email, created_at 
      FROM users 
      WHERE LOWER(member_code) = LOWER($1)`,
     [agentCode]
   );

    if (referredUsers.length === 0) {
      return res.json({ users: [], totalUsers: 0 });
    }

    // Get the IDs of the referred users to fetch their balances
    const userIds = referredUsers.map(u => u.id);

    const { rows: balances } = await pool.query(
      `SELECT user_id, coin, balance FROM user_balances WHERE user_id = ANY($1)`,
      [userIds]
    );

    res.json({
      totalUsers: referredUsers.length,
      users: referredUsers,
      userBalances: balances
    });

  } catch (err) {
    console.error("Agent Dashboard Error:", err);
    res.status(500).json({ error: 'Failed to load Agent Monitor' });
  }
});

module.exports = router;