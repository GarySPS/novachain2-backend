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

// Email HTML Template Helper
const getOtpEmailHtml = (username, otp, message = "Use the verification code below to complete your authentication request.") => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #07090e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #ffffff;">
  <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="padding: 40px 12px;">
    <tr>
      <td align="center">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 440px; background-color: #0f141c; border-radius: 18px; border: 1px solid rgba(255, 255, 255, 0.1); overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
          <tr>
            <td style="padding: 32px 24px 16px 24px; text-align: center;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; color: #ffffff; text-transform: uppercase;">NovaChain</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 24px 28px 24px; text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 15px; color: #e2e8f0;">Hello <strong style="color: #ffffff;">${username || "User"}</strong>,</p>
              <p style="margin: 0 0 22px 0; font-size: 13px; color: #94a3b8; line-height: 1.5;">${message}</p>
              
              <div style="background-color: #171f2c; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px; padding: 16px 20px; margin: 0 auto 22px auto; display: inline-block;">
                <span style="font-family: 'Courier New', Courier, monospace; font-size: 30px; font-weight: 800; letter-spacing: 6px; color: #ffffff;">${otp}</span>
              </div>
              
              <p style="margin: 0; font-size: 11px; color: #64748b; line-height: 1.5;">
                This code is valid for <strong>10 minutes</strong>.<br/>
                Never share this code with anyone, including NovaChain staff.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 24px; background-color: #0b0e14; border-top: 1px solid rgba(255, 255, 255, 0.06); text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #475569;">Automated security notification from NovaChain.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// --- Register (Email or Phone) ---
router.post('/register', async (req, res) => {

  const { username, password, email, phoneNumber, memberCode } = req.body;

  if (!username || !password || (!email && !phoneNumber)) {
    return res.status(400).json({
      error: 'Missing username, password, and either email or phone number'
    });
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
            from: `"NovaChain Security" <${process.env.EMAIL_USER}>`,
            to: targetEmail,
            subject: 'NovaChain OTP Verification',
            text: `Hello ${user.username}, your OTP code is: ${otp}`,
            html: getOtpEmailHtml(user.username, otp, "Use the verification code below to complete your registration.")
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

const hashedPassword = await bcrypt.hash(password, 10);

const newUser = await pool.query(
  'INSERT INTO users (username, email, password, balance, otp, verified, member_code) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
  [username, targetEmail, hashedPassword, 0, otp, false, memberCode || null]
);
    const userId = newUser.rows[0].id;

    const coins = ["USDT", "USDC", "BTC", "ETH", "BNB"];
    await Promise.all(
      coins.map((coin) => pool.query(`INSERT INTO user_balances (user_id, coin, balance) VALUES ($1, $2, 0)`, [userId, coin]))
    );

    if (email) {
      const mailOptions = {
        from: `"NovaChain Security" <${process.env.EMAIL_USER}>`,
        to: targetEmail,
        subject: 'NovaChain OTP Verification',
        text: `Hello ${username}, your OTP code is: ${otp}`,
        html: getOtpEmailHtml(username, otp, "Use the verification code below to complete your registration.")
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

    const payload = { 
      id: user.id, 
      username: user.username, 
      email: user.email,
      isImpersonated: false  // Normal login is not impersonation
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      token,
      user: {
        id: "NC-" + String(user.id).padStart(7, "0"),
        username: user.username,
        email: user.email,
        language: user.language || 'en'
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
    // FIX: Match email regardless of uppercase/lowercase
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (rows.length === 0) {
      return res.json({ message: "If this email exists, OTP sent" });
    }
    const user = rows[0];
    const userEmail = user.email; // Use the exact DB email casing
    
    const otp = crypto.randomInt(100000, 999999).toString();
    await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp, userEmail]);

    const mailOptions = {
      from: `"NovaChain Security" <${process.env.EMAIL_USER}>`,
      to: userEmail,
      subject: 'NovaChain Password Reset OTP',
      text: `Your NovaChain OTP for password reset is: ${otp}`,
      html: getOtpEmailHtml(user.username || "User", otp, "Use the verification code below to reset your NovaChain password.")
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
    // 1. Case-insensitive email search
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (rows.length === 0) return res.status(400).json({ error: "Invalid email or OTP" });

    const user = rows[0];
    if (user.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });

    // 2. Hash the new password before saving it to the database
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // 3. Update using user.id for exact precision
    await pool.query('UPDATE users SET password = $1, otp = NULL WHERE id = $2', [hashedPassword, user.id]);
    
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
    // FIX: Match email regardless of uppercase/lowercase
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No account with that email.' });
    }
    const user = rows[0];
    const userEmail = user.email; // Use exact DB email casing

    const otp = crypto.randomInt(100000, 999999).toString();
    await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp, userEmail]);

    const mailOptions = {
      from: `"NovaChain Security" <${process.env.EMAIL_USER}>`,
      to: userEmail,
      subject: 'NovaChain OTP Verification',
      text: `Hello${user.username ? " " + user.username : ""}, your OTP code is: ${otp}`,
      html: getOtpEmailHtml(user.username, otp, "Here is your requested verification code.")
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
      const username = 'Web3_' + walletAddress.substring(2, 8);
      const dummyPassword = 'WEB3_LOGIN_NO_PASSWORD';

      const newUser = await pool.query(
        'INSERT INTO users (username, email, password, balance, otp, verified) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [username, web3Email, dummyPassword, 0, null, true]
      );
      user = newUser.rows[0];

      // 3. Insert empty balances for all coins
      const coins = ["USDT", "USDC", "BTC", "ETH", "BNB"];
      await Promise.all(
        coins.map((coin) => 
          pool.query(
            `INSERT INTO user_balances (user_id, coin, balance) VALUES ($1, $2, 0)`,
            [user.id, coin]
          )
        )
      );
    }

    // 4. Generate standard JWT token
    const payload = { 
      id: user.id, 
      username: user.username, 
      email: user.email,
      isImpersonated: false 
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      token,
      user: {
        id: "NC-" + String(user.id).padStart(7, "0"),
        username: user.username,
        email: user.email,
        walletAddress: walletAddress,
        language: user.language || 'en'
      }
    });

  } catch (err) {
    console.error('Web3 Login Error:', err);
    res.status(500).json({ error: 'Database error during Web3 login' });
  }
});

// ===== IMPERSONATION ROUTE - Admin login as user =====
router.post('/impersonate', async (req, res) => {
  const { userToken } = req.body;
  
  if (!userToken) {
    return res.status(400).json({ error: 'No token provided' });
  }
  
  try {
    // Verify the impersonation token (sent from admin backend)
    const decoded = jwt.verify(userToken, process.env.JWT_SECRET);
    
    // Check if this is an impersonation token
    if (!decoded.isImpersonation) {
      return res.status(403).json({ error: 'Invalid token type' });
    }
    
    // Log the impersonation attempt
    console.log(`⚠️ IMPERSONATION: Admin ${decoded.impersonatedBy?.email} is logging in as user ${decoded.email} (ID: ${decoded.id})`);
    
    // Get the full user data from database
    const { rows } = await pool.query(
      `SELECT id, username, email, verified, kyc_status, created_at, language 
       FROM users WHERE id = $1`,
      [decoded.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = rows[0];
    
    // Check if user is verified/approved
    if (user.verified === false || user.verified === 0) {
      return res.status(403).json({ 
        error: "User account is not verified. Cannot impersonate unverified users." 
      });
    }
    
    // Create a regular user session token (not the impersonation token)
    const sessionToken = jwt.sign(
      { 
        id: user.id, 
        username: user.username,
        email: user.email,
        isImpersonated: true,  // Flag to identify impersonated session
        impersonatedBy: decoded.impersonatedBy
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // Send back user data and new session token
    res.json({
      success: true,
      token: sessionToken,
      user: {
        id: "NC-" + String(user.id).padStart(7, "0"),
        username: user.username,
        email: user.email,
        language: user.language || 'en',
        verified: user.verified,
        kyc_status: user.kyc_status
      },
      isImpersonated: true,
      impersonatedBy: decoded.impersonatedBy,
      message: `Logged in as ${user.email}`
    });
    
  } catch (error) {
    console.error('Impersonation verification error:', error);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Impersonation token has expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid impersonation token' });
    }
    
    res.status(500).json({ error: 'Failed to impersonate user' });
  }
});

// Optional: Route to check current impersonation status
router.get('/impersonation-status', authenticateToken, async (req, res) => {
  try {
    // Check if the current token has impersonation flag
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.json({ isImpersonated: false });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    res.json({
      isImpersonated: decoded.isImpersonated || false,
      impersonatedBy: decoded.impersonatedBy || null,
      message: decoded.isImpersonated ? 'You are viewing this account as an administrator' : 'Normal user session'
    });
    
  } catch (error) {
    res.json({ isImpersonated: false });
  }
});

// Optional: Route to end impersonation (logout from impersonated session)
router.post('/end-impersonation', authenticateToken, async (req, res) => {
  try {
    // Check if this is an impersonated session
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.isImpersonated) {
      // Log the end of impersonation
      console.log(`🔚 Impersonation ended for user ${decoded.email} by admin ${decoded.impersonatedBy?.email}`);
      
      // You could also invalidate the token here if using a token blacklist
      // For now, just return success and let frontend clear localStorage
    }
    
    res.json({
      success: true,
      message: 'Impersonation session ended. Please log in again.'
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to end impersonation' });
  }
});

module.exports = router;
