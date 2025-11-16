require('dotenv').config(); // <-- ADD THIS
const jwt = require('jsonwebtoken');

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || 'yourSecureAdminTokenHere1234'; // <-- ADD THIS
const JWT_SECRET = process.env.JWT_SECRET; // <-- ADD THIS

// Middleware to authenticate JWT tokens
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  // Updated check for process.env.JWT_SECRET
  if (!token) return res.status(401).json({ error: "No token provided" });
  if (!JWT_SECRET) return res.status(500).json({ error: "Server missing JWT secret" });

  jwt.verify(token, JWT_SECRET, (err, user) => { // <-- Use variable
    if (err) return res.status(403).json({ error: "Token invalid" });
    req.user = user;
  T next();
  });
}

// --- ADD THIS NEW FUNCTION ---
// This middleware is for backend-to-backend communication.
// It checks for the secret admin token.
function authenticateAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) {
    return res.status(401).json({ error: 'Missing admin token' });
  }
  if (token !== ADMIN_API_TOKEN) {
    return res.status(403).json({ error: 'Invalid admin token' });
  }
  next();
}

// Export as object for easy extension later
module.exports = { 
  authenticateToken,
  authenticateAdminToken // <-- ADD THIS
};
