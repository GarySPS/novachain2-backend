//routes>deposit.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authenticateAdminToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();
const { makeQuote, receiptMime, makeMxnReceiptMetadata, parseMxnReceipt, redactMxnReceipt, RECEIPT_PREFIX } = require('../services/mxnDeposit');
const { getMxnSettings } = require('../services/mxnSettings');
const multer = require('multer');
const receiptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 320 * 1024, files: 1, fields: 2 } }).single('screenshot');
const { respondToDepositDecision } = require('../services/settleDeposit');

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

// Read-only preview based on a server-configured MXN-per-USDT exchange rate.
router.get('/mxn-quote', authenticateToken, async (req, res) => {
  try {
    const settings = await getMxnSettings(pool);
    const quote = makeQuote(req.query.amount, settings);
    if (quote.error) return res.status(quote.status).json({ error: quote.error });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...quote });
  } catch (error) {
    console.error('MXN quote settings error:', error.message);
    return res.status(503).json({ error: 'MXN quote temporarily unavailable.' });
  }
});

// Store a small bank-transfer screenshot directly in the existing deposits TEXT
// column. No additional bucket/table and no reliance on Render's ephemeral disk.
// Stored requests remain pending until the actual bank transfer is verified.
router.post('/mxn', authenticateToken, (req, res, next) => {
  receiptUpload(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Receipt image is too large. Choose a smaller screenshot.' : 'Invalid receipt upload.' });
    next();
  });
}, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Please sign in.' });
  let settings;
  try {
    settings = await getMxnSettings(pool);
  } catch (error) {
    console.error('MXN request settings error:', error.message);
    return res.status(503).json({ error: 'MXN settings temporarily unavailable.' });
  }
  const quote = makeQuote(req.body?.mxnAmount, settings);
  if (quote.error) return res.status(quote.status).json({ error: quote.error });
  // Reject a stale destination when a member's wallet already knows the CLABE.
  if (req.body?.paymentClabe && req.body.paymentClabe !== quote.payment.clabe) {
    return res.status(409).json({ error: 'Receiving account changed. Refresh the quote before submitting.' });
  }
  const expectedRate = Number(req.body?.rateMxnPerUsdt);
  if (!Number.isFinite(expectedRate) || expectedRate !== quote.rateMxnPerUsdt) {
    return res.status(409).json({ error: 'Exchange rate changed. Refresh the amount and try again.' });
  }
  const file = req.file;
  if (!file || !file.buffer) return res.status(400).json({ error: 'Upload your bank transfer screenshot.' });
  const mime = receiptMime(file.buffer);
  if (!mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    return res.status(400).json({ error: 'Use a JPG, PNG or WebP screenshot.' });
  }
  if (file.buffer.length > 320 * 1024) return res.status(400).json({ error: 'Receipt exceeds the 320 KB limit.' });

  const metadata = makeMxnReceiptMetadata({
    receipt: { buffer: file.buffer, mime },
    mxnAmount: quote.mxnAmount,
    usdtAmount: quote.usdtAmount,
    rateMxnPerUsdt: quote.rateMxnPerUsdt,
    payment: quote.payment,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Prevent an identical screenshot from creating multiple requests while
    // avoiding expensive scans of all the stored image bytes.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['mxn-receipt:' + metadata.hash]);
    const { rows: duplicateRows } = await client.query(
      `SELECT id FROM deposits WHERE screenshot LIKE $1 AND status IN ('pending', 'approved') LIMIT 1`,
      [RECEIPT_PREFIX + metadata.hash + ':%']
    );
    if (duplicateRows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This receipt has already been submitted.' });
    }
    const { rows } = await client.query(
      `INSERT INTO deposits (user_id, coin, amount, address, screenshot, status)
       VALUES ($1, 'USDT', $2, $3, $4, 'pending') RETURNING id`,
      [userId, quote.usdtAmount, quote.payment.clabe, metadata.stored]
    );
    await client.query('COMMIT');
    return res.status(201).json({
      success: true, id: rows[0].id, status: 'pending', displayStatus: 'Processing',
      mxnAmount: quote.mxnAmount, usdtAmount: quote.usdtAmount,
      rateMxnPerUsdt: quote.rateMxnPerUsdt,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('MXN receipt deposit error:', error);
    return res.status(500).json({ error: 'Unable to record payment request.' });
  } finally { client.release(); }
});

// View one MXN receipt, protected by the existing internal deposit token.
// The member and list endpoints never return the large image bytes.
router.get('/:id/receipt', authenticateAdminToken, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid request ID.' });
  try {
    const { rows } = await pool.query('SELECT screenshot FROM deposits WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Deposit not found.' });
    const parsed = parseMxnReceipt(rows[0].screenshot);
    if (!parsed || !parsed.imageBase64 || !['image/jpeg','image/png','image/webp'].includes(parsed.receiptMime)) {
      return res.status(404).json({ error: 'MXN receipt unavailable.' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ imageDataUrl: `data:${parsed.receiptMime};base64,${parsed.imageBase64}` });
  } catch (error) {
    console.error('MXN receipt lookup error:', error);
    return res.status(500).json({ error: 'Unable to load receipt.' });
  }
});

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
      
      // --- SEND GMAIL NOTIFICATION ---
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: process.env.ADMIN_EMAIL, 
          subject: `New Deposit: ${amount} ${coin}`,
          text: `A new deposit was submitted.\n\nUser ID: ${user_id}\nAmount: ${amount} ${coin}\nTx/Screenshot: ${screenshot}\nStatus: ${initialStatus}`
        }).catch(err => console.error("Email error:", err));
      } catch (mailErr) {}
      // -------------------------------

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
        SELECT deposits.*, users.email as user_email, users.username 
        FROM deposits 
        LEFT JOIN users ON deposits.user_id = users.id 
        ORDER BY deposits.created_at DESC
      `);
      return res.json(result.rows.map(row => ({ ...row, screenshot: redactMxnReceipt(row.screenshot) })));
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
    res.json(result.rows.map(row => ({ ...row, screenshot: redactMxnReceipt(row.screenshot) })));
  } catch (err) {
    res.status(500).json({ error: 'Database error (user)' });
  }
});

// Legacy deposit status API shares the same exactly-once approval logic.
router.put('/:id/status', authenticateAdminToken, (req, res) => {
  return respondToDepositDecision(req, res, req.body?.status);
});

module.exports = router;
