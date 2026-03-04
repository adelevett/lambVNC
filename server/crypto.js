const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let DATA_DIR = path.join(__dirname, '..', 'data');
let encryptionKey = null;

/**
 * Test seam: override data directory (must be called before first encrypt/decrypt)
 * @param {string} dir
 */
function _setDataDir(dir) {
  DATA_DIR = dir;
  encryptionKey = null; // force re-read on next use
}

/**
 * Gets or generates the encryption key from data/.key (lazy)
 * @returns {Buffer}
 */
function getEncryptionKey() {
  if (encryptionKey) return encryptionKey;

  const keyPath = path.join(DATA_DIR, '.key');
  if (!fs.existsSync(keyPath)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key);
    console.warn('\x1b[33m%s\x1b[0m', '⚠  LambVNC: Encryption key generated at data/.key');
    console.warn('\x1b[33m%s\x1b[0m', '   This file is NOT backed up automatically.');
    console.warn('\x1b[33m%s\x1b[0m', '   Loss of data/.key makes all stored VNC passwords permanently unrecoverable.');
    console.warn('\x1b[33m%s\x1b[0m', '   Back up data/.key to a secure location now.');
    encryptionKey = key;
    return key;
  }
  encryptionKey = fs.readFileSync(keyPath);
  return encryptionKey;
}

/**
 * Encrypts a VNC password using AES-256-GCM
 * @param {string} password
 * @returns {{encrypted: string, iv: string, tag: string}}
 */
function encryptPassword(password) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(password, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

/**
 * Decrypts a VNC password using AES-256-GCM
 * @param {{encrypted: string, iv: string, tag: string}} stored
 * @returns {string}
 */
function decryptPassword(stored) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(stored.iv, 'base64')
  );

  decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));

  let decrypted = decipher.update(stored.encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = {
  _setDataDir,
  encryptPassword,
  decryptPassword
};
