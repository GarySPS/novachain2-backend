//routes>auth.js

const bcrypt = require('bcrypt');
const { authenticateToken } = require('../middleware/auth');
const express = require('express');
const router = express.Router();
const pool = require('../db');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Register (Handles both Email and Phone signups)
router.post('/register', async (req, res) => {
  const { username, email, phoneNumber, password, memberCode } = req.body;
  
  if (!username || !password || (!email && !phoneNumber)) {
  return res.status(400).json({ error: 'Missing username, password, and either email or phone number' });
}

if (phoneNumber && !memberCode) {
  return res.status(400).json({ error: 'Member code required for Telegram signup' });
}
    return res.status(400).json({ error: 'Missing username, password, and either email or phone number' });
  }

  // Generate a demo email if using phone
  const targetEmail = email ? email : `${phoneNumber.replace(/[^0-9+]/g, '')}@phone.demo`;

  try {
    // Check duplicate email / telegram demo email
    const { rows: existing } = await pool.query('SELECT * FROM users WHERE email = $1', [targetEmail]);
    if (existing.length > 0) {
      const user = existing[0];
      if (!user.verified) {
        const otp = crypto.randomInt(100000, 999999).toString();
        await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp, targetEmail]);
        
        if (email) {
          const mailOptions = {
            from: process.env.EMAIL_USER,
            to: targetEmail,
            subject: 'NovaChain OTP Verification',
            text: `Hello ${user.username}, your OTP code is: ${otp}`
          };
          transporter.sendMail(mailOptions, (err) => {
            if (err) console.error('❌ OTP email error:', err);
          });
          return res.status(200).json({ unverified: true, message: 'Account exists but not verified. New OTP sent.' });
        } else {
          return res.status(200).json({ unverified: true, message: 'Account exists but pending admin approval.' });
        }
      } else {
        return res.status(409).json({ error: 'This account is already registered. Please log in.' });
      }
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    const newUser = await pool.query(
  'INSERT INTO users (username, email, password, balance, otp, verified, member_code) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
  [username, targetEmail, password, 0, otp, false, memberCode || null]
);
    const userId = newUser.rows[0].id;

    const coins = ["USDT", "BTC", "ETH", "SOL", "XRP", "TON"];
    await Promise.all(
      coins.map((coin) => pool.query(`INSERT INTO user_balances (user_id, coin, balance) VALUES ($1, $2, 0)`, [userId, coin]))
    );

    if (email) {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: targetEmail,
        subject: 'NovaChain OTP Verification',
        text: `Hello ${username}, your OTP code is: ${otp}`
      };
      transporter.sendMail(mailOptions, (err) => {
        if (err) console.error('❌ OTP email error:', err);
      });
      res.status(201).json({ message: 'User registered! OTP sent.', userId });
    } else {
      res.status(201).json({ message: 'Account created! Pending Admin approval.', userId });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login (returns JWT, supports email, username, or telegram number)
router.post('/login', async (req, res) => {
  const { email, password } = req.body; 
  
  // Auto-format if user typed a phone number instead of an email or username
  const loginIdentifier = (!email.includes('@') && email.match(/^\+?[0-9]+$/)) 
    ? `${email.replace(/[^0-9+]/g, '')}@phone.demo` 
    : email;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)`,
      [loginIdentifier, email]
    );
    const user = rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    let match = false;
    if (user.password.startsWith("$2b$")) {
      match = await bcrypt.compare(password, user.password);
    } else {
      match = (password === user.password);
    }
    if (!match) return res.status(400).json({ error: 'Invalid credentials' });

    if (user.verified === false || user.verified === 0) {
      return res.status(403).json({ error: "Please verify your email or wait for Admin approval before logging in." });
    }

    const payload = { id: user.id, username: user.username, email: user.email };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: "NC-" + String(user.id).padStart(7, "0"),
        username: user.username,
        email: user.email
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});




// OTP Verification (POSTGRES BOOLEAN SAFE)
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.otp === otp) {
      await pool.query('UPDATE users SET verified = TRUE WHERE email = $1', [email]);
      res.json({ message: 'Email verified successfully' });
    } else {
      res.status(400).json({ error: 'Invalid OTP' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Forgot Password: Send OTP to Email ---
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      // Always return OK for privacy
      return res.json({ message: "If this email exists, OTP sent" });
    }
    const user = rows[0];
    const otp = crypto.randomInt(100000, 999999).toString();
    await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp, email]);

    // Send email with OTP
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'NovaChain Password Reset OTP',
      text: `Your NovaChain OTP for password reset is: ${otp}`
    };
    transporter.sendMail(mailOptions, (err) => {
      if (err) console.error('❌ OTP email error:', err);
    });

    return res.json({ message: "If this email exists, OTP sent" });
  } catch (err) {
    console.error('Forgot password error', err);
    return res.status(500).json({ error: "Server error" });
  }
});

// --- Reset Password with OTP ---
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.status(400).json({ error: "All fields required" });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) return res.status(400).json({ error: "Invalid email or OTP" });

    const user = rows[0];
    if (user.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });

    await pool.query('UPDATE users SET password = $1, otp = NULL WHERE email = $2', [newPassword, email]);
    return res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error('Reset password error', err);
    return res.status(500).json({ error: "Server error" });
  }
});

// --- Resend OTP (for registration) ---
router.post('/resend-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    // Check if user exists
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No account with that email.' });
    }
    const user = rows[0];

    // Generate a new OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp, email]);

    // Send OTP Email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'NovaChain OTP Verification',
      text: `Hello${user.username ? " " + user.username : ""}, your OTP code is: ${otp}`
    };
    transporter.sendMail(mailOptions, (err) => {
      if (err) {
        console.error('❌ OTP resend email error:', err);
        return res.status(500).json({ error: 'Failed to send OTP email.' });
      }
      res.json({ message: 'OTP code resent. Please check your email.' });
    });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Server error, could not resend OTP.' });
  }
});

// --- Web3 Login / Registration ---
router.post('/web3-login', async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Wallet address required' });

  try {
    // 1. Check if user already exists using the wallet address as a dummy email
    const web3Email = `${walletAddress.toLowerCase()}@web3.novachain`;
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [web3Email]);
    
    let user = rows[0];

    if (!user) {
      // 2. Create new Web3 user if they don't exist
      const username = 'Web3_' + walletAddress.substring(2, 8); // e.g., Web3_1a2b3c
      const dummyPassword = 'WEB3_LOGIN_NO_PASSWORD'; // They use their wallet to sign in, not a password

      const newUser = await pool.query(
        'INSERT INTO users (username, email, password, balance, otp, verified) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [username, web3Email, dummyPassword, 0, null, true] // verified is instantly true
      );
      user = newUser.rows[0];

      // 3. Insert empty balances for all coins
      const coins = ["USDT", "BTC", "ETH", "SOL", "XRP", "TON"];
      await Promise.all(
        coins.map((coin) => 
          pool.query(
            `INSERT INTO user_balances (user_id, coin, balance) VALUES ($1, $2, 0)`,
            [user.id, coin]
          )
        )
      );
    }

    // 4. Generate standard JWT token so the frontend handles them like a normal user
    const payload = { id: user.id, username: user.username, email: user.email };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      token,
      user: {
        id: "NC-" + String(user.id).padStart(7, "0"),
        username: user.username,
        email: user.email,
        walletAddress: walletAddress
      }
    });

  } catch (err) {
    console.error('Web3 Login Error:', err);
    res.status(500).json({ error: 'Database error during Web3 login' });
  }
});

module.exports = router;
