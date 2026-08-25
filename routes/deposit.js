//routes>deposit.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authenticateAdminToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

// Public RPC nodes for on-chain verification
const RPC_URLS = {
  ETH: 'https://cloudflare-eth.com',
  BNB: 'https://bsc-dataseed.binance.org'
};

async function verifyEvmTransaction(txHash, expectedRecipient, coin) {
  const rpcUrl = RPC_URLS[coin] || RPC_URLS.ETH;

  try {
    // 1. Check if the transaction succeeded on-chain
    const receiptRes = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      method: 'eth_getTransactionReceipt',
      params: [txHash],
      id: 1
    });

    const receipt = receiptRes.data?.result;
    if (!receipt || receipt.status !== '0x1') {
      return { verified: false, error: 'Transaction failed or pending confirmation' };
    }

    // 2. Fetch transaction details to confirm recipient matches admin address
    const txRes = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      method: 'eth_getTransactionByHash',
      params: [txHash],
      id: 2
    });

    const tx = txRes.data?.result;
    if (!tx) {
      return { verified: false, error: 'Transaction details not found' };
    }

    if (tx.to?.toLowerCase() !== expectedRecipient.toLowerCase()) {
      return { verified: false, error: 'Recipient address mismatch' };
    }

    return { verified: true };
  } catch (err) {
    console.error('Blockchain RPC verification error:', err.message);
    return { verified: false, error: 'RPC connection error' };
  }
}

// --- Create Deposit (With Auto-Verification for Web3) ---
router.post(
  '/',
  authenticateToken,
  async (req, res) => {
    const user_id = req.user.id;
    const { coin, amount, address, screenshot } = req.body; 

    console.log("🔍 BACKEND: Received deposit request:", {
      user_id, coin, amount, address, screenshot
    });

    if (!user_id || !coin || !amount || !address || !screenshot) {
      console.log("❌ BACKEND: Missing required fields");
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isWeb3 = typeof screenshot === 'string' && screenshot.startsWith('web3-tx-');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      let initialStatus = 'pending';

      // --- AUTOMATED WEB3 VERIFICATION ---
      if (isWeb3) {
        const txHash = screenshot.replace('web3-tx-', '').trim();

        // 1. Prevent double spending (check if hash was already approved)
        const { rows: existingTx } = await client.query(
          `SELECT id FROM deposits WHERE screenshot = $1 AND status = 'approved'`,
          [screenshot]
        );

        if (existingTx.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'This transaction hash has already been credited.' });
        }

        // 2. Verify on-chain (ETH / BNB)
        if (coin === 'ETH' || coin === 'BNB') {
          const check = await verifyEvmTransaction(txHash, address, coin);
          if (check.verified) {
            initialStatus = 'approved';
            console.log(`✅ BACKEND: Auto-verified Web3 deposit on-chain for ${coin}`);
          } else {
            console.log(`⚠️ BACKEND: Web3 on-chain check unverified (${check.error || 'unknown'}), falling back to pending`);
          }
        }
      }

      // --- INSERT DEPOSIT RECORD ---
      const depositResult = await client.query(
        `INSERT INTO deposits (user_id, coin, amount, address, screenshot, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user_id, coin, amount, address, screenshot, initialStatus]
      );
      
      const depositId = depositResult.rows[0].id;

      // --- IF AUTO-APPROVED: CREDIT USER BALANCE IMMEDIATELY ---
      if (initialStatus === 'approved') {
        await client.query(
          `INSERT INTO user_balances (user_id, coin, balance)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, coin) DO UPDATE
           SET balance = user_balances.balance + EXCLUDED.balance`,
          [user_id, coin, amount]
        );

        const { rows: balanceRows } = await client.query(
          `SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2`,
          [user_id, coin]
        );
        const newBalance = balanceRows[0] ? parseFloat(balanceRows[0].balance) : 0;

        let price_usd = 1;
        if (coin !== 'USDT') {
          const { rows: priceRows } = await client.query(
            `SELECT price_usd FROM prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1`,
            [coin]
          );
          price_usd = priceRows[0] ? parseFloat(priceRows[0].price_usd) : 1;
          if (!price_usd || isNaN(price_usd)) price_usd = 1;
        }

        await client.query(
          `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
           VALUES ($1, $2, $3, $4, NOW())`,
          [user_id, coin, newBalance, price_usd]
        );
      }

      await client.query('COMMIT');
      
      console.log(`✅ BACKEND: Deposit recorded (ID: ${depositId}, Status: ${initialStatus})`);
      res.json({ success: true, id: depositId, status: initialStatus, autoApproved: initialStatus === 'approved' });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error("❌ BACKEND: DEPOSIT CREATE FAILED:", err);
      res.status(500).json({ error: 'Database error', detail: err.message });
    } finally {
      client.release();
    }
  }
);

// --- Get all deposits (SECURED for admin view or user view) ---
router.get('/', async (req, res) => {
  // --- Admin view (checks for x-admin-token) ---
  if (req.headers['x-admin-token'] && req.headers['x-admin-token'] === process.env.ADMIN_API_TOKEN) {
    try {
      const result = await pool.query(`
        SELECT deposits.*, users.email as user_email 
        FROM deposits 
        LEFT JOIN users ON deposits.user_id = users.id 
        ORDER BY deposits.created_at DESC
      `);
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
router.put(
  '/:id/status',
  authenticateAdminToken,
  async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const client = await pool.connect();

    try {
      const { rows } = await client.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [id]);
      const deposit = rows[0];
      if (!deposit) return res.status(404).json({ error: "Deposit not found" });

      if (deposit.status === "approved" || deposit.status === "rejected") {
        return res.status(400).json({ error: `Deposit is already ${deposit.status}` });
      }

      await client.query('BEGIN');

      await client.query('UPDATE deposits SET status = $1 WHERE id = $2', [status, id]);

      if (status === "approved") {
        await client.query(
          `INSERT INTO user_balances (user_id, coin, balance)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, coin) DO UPDATE
           SET balance = user_balances.balance + EXCLUDED.balance`,
          [deposit.user_id, deposit.coin, deposit.amount]
        );

        const { rows: balanceRows } = await client.query(
          `SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2`,
          [deposit.user_id, deposit.coin]
        );
        const newBalance = balanceRows[0] ? parseFloat(balanceRows[0].balance) : 0;

        let price_usd = 1;
        if (deposit.coin !== "USDT") {
          const { rows: priceRows } = await client.query(
            `SELECT price_usd FROM prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1`,
            [deposit.coin]
          );
          price_usd = priceRows[0] ? parseFloat(priceRows[0].price_usd) : 1;
          if (!price_usd || isNaN(price_usd)) price_usd = 1;
        }

        await client.query(
          `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
           VALUES ($1, $2, $3, $4, NOW())`,
          [deposit.user_id, deposit.coin, newBalance, price_usd]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true, message: `Deposit ${id} ${status}` });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error("Deposit approve/reject error:", err);
      res.status(500).json({ error: 'Database error', detail: err.message });
    } finally {
      client.release();
    }
  }
);

module.exports = router;