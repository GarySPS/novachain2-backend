//middleware>auth.js

require('dotenv').config();
const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'Server missing JWT secret' });
  jwt.verify(token, process.env.JWT_SECRET, (error, user) => {
    if (error) return res.status(403).json({ error: 'Token invalid' });
    req.user = user;
    next();
  });
}

function authenticateAdminToken(req, res, next) {
  // An absent server token never authorizes a payment decision.
  if (!process.env.ADMIN_API_TOKEN) return res.status(503).json({ error: 'Admin API is not configured' });
  if (!req.headers['x-admin-token']) return res.status(401).json({ error: 'Missing admin token' });
  if (req.headers['x-admin-token'] !== process.env.ADMIN_API_TOKEN) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
  next();
}

module.exports = { authenticateToken, authenticateAdminToken };
