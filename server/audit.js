const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

let DATA_DIR = path.join(__dirname, '..', 'data');
let DB_PATH = path.join(DATA_DIR, 'audit.db');
let db = null;

/**
 * Test seam: override data directory
 * @param {string} dir
 */
function _setDataDir(dir) {
  DATA_DIR = dir;
  DB_PATH = path.join(dir, 'audit.db');
}

/**
 * Initializes the database.
 * MUST be called after data/ directory is ensured in index.js.
 */
function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create schema if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash  TEXT    NOT NULL,
      ip          TEXT    NOT NULL,
      logged_in   INTEGER NOT NULL,
      logged_out  INTEGER
    );
    CREATE TABLE IF NOT EXISTS connections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id),
      host_id     TEXT    NOT NULL,
      connected   INTEGER NOT NULL,
      disconnected INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_connections_session ON connections(session_id);
    CREATE INDEX IF NOT EXISTS idx_connections_host    ON connections(host_id);
  `);
}

/**
 * SHA-256 hash of a token for audit storage
 * @param {string} token
 * @returns {string}
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Log session login. Hashes the raw JWT internally before storage.
 * @param {string} rawToken - the raw JWT (will be hashed, never stored raw)
 * @param {string} ip - IP address
 * @returns {number} session_id
 */
function logLogin(rawToken, ip) {
  if (!db) throw new Error('Database not initialized');
  const tokenHash = hashToken(rawToken);
  const stmt = db.prepare(`
    INSERT INTO sessions (token_hash, ip, logged_in)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(tokenHash, ip, Math.floor(Date.now() / 1000));
  return result.lastInsertRowid;
}

/**
 * Log session logout by session ID
 * @param {number} sessionId
 */
function logLogout(sessionId) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(`
    UPDATE sessions SET logged_out = ? WHERE id = ?
  `);
  stmt.run(Math.floor(Date.now() / 1000), sessionId);
}

/**
 * Log session logout by raw token (hashed internally)
 * @param {string} rawToken
 */
function logLogoutByToken(rawToken) {
  if (!db) throw new Error('Database not initialized');
  const tokenHash = hashToken(rawToken);
  const stmt = db.prepare(`
    UPDATE sessions SET logged_out = ? WHERE token_hash = ? AND logged_out IS NULL
  `);
  stmt.run(Math.floor(Date.now() / 1000), tokenHash);
}

/**
 * Get session row by raw token (hashed internally for lookup)
 * @param {string} rawToken
 * @returns {{ id: number }|null}
 */
function getSessionByToken(rawToken) {
  if (!db) return null;
  const tokenHash = hashToken(rawToken);
  const stmt = db.prepare(`SELECT id FROM sessions WHERE token_hash = ? ORDER BY logged_in DESC LIMIT 1`);
  return stmt.get(tokenHash) || null;
}

/**
 * Log connection
 * @param {number} sessionId
 * @param {string} hostId
 * @returns {number} connection_id
 */
function logConnection(sessionId, hostId) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(`
    INSERT INTO connections (session_id, host_id, connected)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(sessionId, hostId, Math.floor(Date.now() / 1000));
  return result.lastInsertRowid;
}

/**
 * Log disconnection
 * @param {number} connectionId
 */
function logDisconnection(connectionId) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(`
    UPDATE connections SET disconnected = ? WHERE id = ?
  `);
  stmt.run(Math.floor(Date.now() / 1000), connectionId);
}

/**
 * Prune audit log
 * @param {number} days
 */
function pruneAuditLog(days) {
  if (!db) throw new Error('Database not initialized');
  const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

  // SPEC: MUST cascade: first DELETE connections, then sessions
  const pruneConnections = db.prepare(`
    DELETE FROM connections WHERE session_id IN (SELECT id FROM sessions WHERE logged_in < ?)
  `);
  pruneConnections.run(cutoff);

  const pruneSessions = db.prepare(`
    DELETE FROM sessions WHERE logged_in < ?
  `);
  pruneSessions.run(cutoff);
}

/**
 * Get audit log size in bytes
 * @returns {number}
 */
function getAuditLogSize() {
  try {
    const stats = fs.statSync(DB_PATH);
    return stats.size;
  } catch (err) {
    return 0;
  }
}

/**
 * Get count of active sessions
 * @returns {number}
 */
function getActiveSessionCount() {
  if (!db) return 0;
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM sessions WHERE logged_out IS NULL
  `);
  return stmt.get().count;
}

// ---------------------------------------------------------------------------
// Test seams: underscore-prefixed exports for test suite access
// ---------------------------------------------------------------------------

/** @returns {string} */
function _getJournalMode() {
  if (!db) throw new Error('Database not initialized');
  return db.pragma('journal_mode', { simple: true });
}

/** @param {string} table @returns {Array} */
function _getColumns(table) {
  if (!db) throw new Error('Database not initialized');
  return db.pragma(`table_info(${table})`);
}

/** @param {number} sessionId @returns {Object|null} */
function _getSession(sessionId) {
  if (!db) return null;
  const stmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  return stmt.get(sessionId) || null;
}

/** @param {number} sessionId @returns {number} */
function _countConnections(sessionId) {
  if (!db) return 0;
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM connections WHERE session_id = ?`);
  return stmt.get(sessionId).count;
}

module.exports = {
  initDb,
  _init: initDb,
  _setDataDir,
  _getJournalMode,
  _getColumns,
  _getSession,
  _countConnections,
  logLogin,
  logLogout,
  logLogoutByToken,
  logConnection,
  logDisconnection,
  getSessionByToken,
  pruneAuditLog,
  getAuditLogSize,
  getActiveSessionCount
};
