const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const audit = require('./audit');

let DATA_DIR = path.join(__dirname, '..', 'data');
let jwtSecret = null;

/**
 * Test seam: override data directory (must be called before first auth operation)
 * @param {string} dir
 */
function _setDataDir(dir) {
  DATA_DIR = dir;
  jwtSecret = null; // force re-read on next use
}

/**
 * Gets or generates the JWT secret (lazy)
 * @returns {Buffer}
 */
function getJwtSecret() {
  if (jwtSecret) return jwtSecret;

  const secretPath = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(secretPath)) {
    const secret = crypto.randomBytes(64);
    fs.writeFileSync(secretPath, secret);
    console.warn('\x1b[33m%s\x1b[0m', '⚠  LambVNC: JWT secret generated at data/.secret');
    console.warn('\x1b[33m%s\x1b[0m', '   This file is NOT backed up automatically.');
    console.warn('\x1b[33m%s\x1b[0m', '   Back up data/.secret to a secure location now.');
    jwtSecret = secret;
    return secret;
  }
  jwtSecret = fs.readFileSync(secretPath);
  return jwtSecret;
}

/**
 * Verifies the admin password
 * @param {string} password
 * @returns {boolean}
 */
function verifyPassword(password) {
  const hashPath = path.join(DATA_DIR, 'admin.hash');
  if (!fs.existsSync(hashPath)) {
    return false;
  }
  const hash = fs.readFileSync(hashPath, 'utf8');

  // Bcrypt internally uses timing-safe comparison,
  // but spec mandates crypto.timingSafeEqual for the orchestrator.
  const match = bcrypt.compareSync(password, hash);
  const buf1 = Buffer.from([match ? 1 : 0]);
  const buf2 = Buffer.from([1]);
  return crypto.timingSafeEqual(buf1, buf2);
}

/**
 * Signs a JWT
 * @param {Object} payload
 * @param {number} expiresIn (seconds)
 * @returns {string}
 */
function signToken(payload, expiresIn) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}

/**
 * Verifies a JWT
 * @param {string} token
 * @returns {Object|null}
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (err) {
    return null;
  }
}

/**
 * Manual cookie parser for WebSocket upgrade events
 * @param {string} cookieHeader
 * @returns {Object}
 */
function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [key, ...v] = c.trim().split('=');
      return [key, decodeURIComponent(v.join('='))];
    })
  );
}

/**
 * Auth rate limiter
 * @param {Object} config
 */
function createAuthLimiter(config) {
  return rateLimit({
    windowMs: (config.rateLimitWindow || 900) * 1000,
    max: config.rateLimitMax || 10,
    message: 'Too many login attempts from this IP, please try again after 15 minutes.'
  });
}

/**
 * Middleware to protect routes
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
function authMiddleware(req, res, next) {
  const token = req.cookies?.token || parseCookies(req.headers.cookie || '').token;

  if (!token || !verifyToken(token)) {
    // API requests get 401 JSON; browser navigation gets redirected to /login
    if (req.path.startsWith('/api/') || req.path === '/health') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
  }

  req.user = verifyToken(token);
  next();
}

/**
 * Route handler for POST /login
 */
function handleLogin(config) {
  return (req, res) => {
    const { password } = req.body;
    if (verifyPassword(password)) {
      const ip = req.ip || req.connection.remoteAddress;

      // SPEC: Sign token, audit logs the raw token (hashes internally)
      const token = signToken({ admin: true }, config.sessionTtl);
      audit.logLogin(token, ip);

      res.cookie('token', token, {
        httpOnly: true,
        secure: config.tls === true,
        sameSite: 'strict',
        maxAge: config.sessionTtl * 1000
      });

      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  };
}

/**
 * Route handler for POST /logout
 */
function handleLogout(req, res) {
  const token = req.cookies?.token || parseCookies(req.headers.cookie || '').token;
  if (token) {
    audit.logLogoutByToken(token);
  }
  res.clearCookie('token');
  res.json({ success: true });
}

module.exports = {
  _setDataDir,
  verifyPassword,
  signToken,
  verifyToken,
  parseCookies,
  createAuthLimiter,
  authMiddleware,
  handleLogin,
  handleLogout
};
