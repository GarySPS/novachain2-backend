// routes/balance.js
// routes/balance.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateToken } = require("../middleware/auth");

// GET /api/balance
// JWT-protected, returns all supported coins even if balance is 0
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT coin, balance, frozen FROM user_balances WHERE user_id = $1",
      [req.user.id]
    );

    // Must match admin BalanceAdjuster coin list
    const allCoins = ["USDT", "USDC", "BTC", "ETH", "BNB", "SOL", "XRP"];

    const toNumber = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    };

    const assets = allCoins.map((symbol) => {
      const row = rows.find((r) => r.coin === symbol);

      return {
        symbol,
        balance: row ? toNumber(row.balance) : 0,
        frozen: row ? toNumber(row.frozen) : 0,
      };
    });

    res.json({ assets });
  } catch (err) {
    console.error("BALANCE FETCH ERROR:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;