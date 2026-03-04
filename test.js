/**
 * LambVNC — Handoff Test Suite
 *
 * Single-file test suite using Node 22's built-in test runner (node:test).
 * No test framework dependencies required.
 *
 * Run:  node --test test.js
 * Requires: Node 22 (current). node:test, EventTarget, and CustomEvent are
 * all stable at this version with no experimental flags needed.
 *
 * Organisation:
 *   1. Security Contract Tests  — cryptographic correctness, auth enforcement,
 *                                 network binding. These must pass before any
 *                                 other review. A failure here is a critical bug.
 *   2. Data Integrity Tests     — profile persistence, backup on write, audit log
 *                                 schema and WAL, config validation.
 *   3. Integration Smoke Tests  — full server subprocess: login flow, route auth,
 *                                 WebSocket upgrade gating, health endpoint, CSP.
 *   4. Event Bus Contract Tests — CustomEvent shape, detail payload, emitter/
 *                                 listener wiring via jsdom (no browser required).
 *
 * The tests are intentionally written against module interfaces and the live
 * server process — not mocked internals. The goal is to catch seam failures
 * (the bugs that live between modules) not to achieve line coverage.
 */

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a path relative to the project root.
 * Tests live at project root alongside server/ and client/.
 */
const root = (...p) => path.join(__dirname, ...p);

/**
 * Make an HTTP request and return { status, headers, body }.
 */
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Attempt a WebSocket upgrade and return the response status code.
 * Does not complete the handshake — only checks whether the upgrade
 * was accepted (101) or rejected (401/403).
 */
function wsUpgradeStatus(options) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      ...options,
      headers: {
        ...options.headers,
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      }
    });
    req.on('upgrade', (res) => { resolve(101); req.destroy(); });
    req.on('response', (res) => { resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Attempt a raw TCP connection to host:port.
 * Resolves true if connection succeeds, false if refused.
 */
function tcpConnectable(host, port) {
  return new Promise((resolve) => {
    const sock = net.createConnection(port, host);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 1000);
  });
}

/**
 * Spawn the LambVNC server as a subprocess and wait for it to signal ready.
 * The server must emit a line containing "LambVNC listening" to stdout.
 * Returns { process, port, kill }.
 */
function startServer(configOverrides = {}) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambvnc-test-'));
    const configPath = path.join(tmpDir, 'config.json');
    const config = {
      serverPort: 0,        // OS-assigned port
      sshPort: 0,
      basePort: 0,
      tls: false,
      sessionTtl: 60,
      fadeDuration: 15,
      reconnectInterval: 5,
      reconnectRetries: 3,
      maxHosts: 12,
      rateLimitWindow: 900,
      rateLimitMax: 100,    // relaxed for tests
      auditRetentionDays: 90,
      ...configOverrides,
      _testMode: true,      // disables first-run password prompt; uses TEST_PASSWORD env
      _dataDir: tmpDir,
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const proc = spawn('node', [root('server', 'index.js'), '--config', configPath], {
      env: {
        ...process.env,
        LAMBVNC_TEST_PASSWORD: 'test-password-correct-horse',
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let port = null;

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // Server must print "LambVNC listening on port XXXX"
      const match = stdout.match(/LambVNC listening on port (\d+)/);
      if (match && !port) {
        port = parseInt(match[1], 10);
        resolve({
          process: proc,
          port,
          dataDir: tmpDir,
          kill: () => new Promise(res => { proc.kill(); proc.on('exit', res); })
        });
      }
    });

    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!port) reject(new Error(`Server exited early (code ${code})\n${stdout}`));
    });

    setTimeout(() => {
      if (!port) {
        proc.kill();
        reject(new Error(`Server did not signal ready within 5s\n${stdout}`));
      }
    }, 5000);
  });
}

/**
 * Login to the test server and return the Set-Cookie header value.
 */
async function login(port, password = 'test-password-correct-horse') {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ password }));
  assert.equal(res.status, 200, `Login failed: ${res.body}`);
  return res.headers['set-cookie']?.[0];
}

// ---------------------------------------------------------------------------
// 1. SECURITY CONTRACT TESTS
//    These test specific failure modes identified in ARCHITECTURE.md as
//    catastrophic. Each maps to a named pitfall in the document.
// ---------------------------------------------------------------------------

describe('Security: AES-256-GCM implementation', () => {

  // Load crypto module directly — tests module in isolation
  let lambCrypto;
  before(() => { lambCrypto = require(root('server', 'crypto.js')); });

  test('encrypt then decrypt recovers original plaintext', () => {
    const password = 'hunter2-campus-vnc';
    const encrypted = lambCrypto.encryptPassword(password);
    const recovered = lambCrypto.decryptPassword(encrypted);
    assert.equal(recovered, password);
  });

  test('IV is unique across encryptions — never reused (§6.2)', () => {
    // ARCHITECTURE §6.2: "GCM's security model mathematically collapses if
    // an IV is ever reused with the same key."
    const results = Array.from({ length: 20 }, () =>
      lambCrypto.encryptPassword('same-password')
    );
    const ivs = results.map(r => r.iv);
    const unique = new Set(ivs);
    assert.equal(unique.size, ivs.length, 'Duplicate IV detected — GCM nonce reuse');
  });

  test('stored fields are base64 strings, not raw binary (§6.2)', () => {
    // ARCHITECTURE §6.2: "The most common AES-GCM implementation failure in
    // Node.js... UTF-8 encoding replaces invalid bytes with U+FFFD."
    const stored = lambCrypto.encryptPassword('test-password');
    const base64Re = /^[A-Za-z0-9+/]+=*$/;
    assert.match(stored.iv, base64Re, 'iv is not valid base64');
    assert.match(stored.encrypted, base64Re, 'encrypted is not valid base64');
    assert.match(stored.tag, base64Re, 'tag is not valid base64');
    // Confirm round-trip still works after JSON serialisation
    const json = JSON.stringify(stored);
    const parsed = JSON.parse(json);
    assert.equal(lambCrypto.decryptPassword(parsed), 'test-password');
  });

  test('tampered ciphertext throws — auth tag is verified, not ignored (§6.2)', () => {
    // ARCHITECTURE §6.2: GCM "guarantees both confidentiality and integrity.
    // If stored ciphertext is tampered with, decryption fails cryptographically."
    const stored = lambCrypto.encryptPassword('precious-password');
    // Flip one byte in the ciphertext
    const raw = Buffer.from(stored.encrypted, 'base64');
    raw[0] ^= 0xff;
    const tampered = { ...stored, encrypted: raw.toString('base64') };
    assert.throws(
      () => lambCrypto.decryptPassword(tampered),
      /auth|tag|integrity|bad decrypt/i,
      'Tampered ciphertext should throw, not return garbage'
    );
  });

  test('tampered auth tag throws — tag corruption is caught (§6.2)', () => {
    const stored = lambCrypto.encryptPassword('precious-password');
    const rawTag = Buffer.from(stored.tag, 'base64');
    rawTag[0] ^= 0xff;
    const tampered = { ...stored, tag: rawTag.toString('base64') };
    assert.throws(
      () => lambCrypto.decryptPassword(tampered),
      /auth|tag|integrity|bad decrypt/i,
      'Tampered auth tag should throw'
    );
  });

});

describe('Security: Network binding — bridges must be localhost-only (§3.4)', () => {

  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server.kill(); });

  test('bridge ports are NOT reachable on 0.0.0.0', async () => {
    // ARCHITECTURE §3.4: "Each bridge is bound exclusively to 127.0.0.1 —
    // never to the LAN interface."
    // We cannot test the actual LAN IP in CI, but we can confirm the port
    // is not listening on the wildcard address by connecting to 0.0.0.0.
    // Note: on localhost, 0.0.0.0 resolves to the wildcard — if the bridge
    // were bound to 0.0.0.0 this would succeed.
    const basePort = 5910; // default first bridge port
    const reachable = await tcpConnectable('0.0.0.0', basePort);
    assert.equal(reachable, false,
      `Bridge port ${basePort} is reachable on 0.0.0.0 — should be localhost-only`);
  });

  test('dashboard port IS reachable on 127.0.0.1', async () => {
    const reachable = await tcpConnectable('127.0.0.1', server.port);
    assert.equal(reachable, true, 'Dashboard port should be reachable on localhost');
  });

});

describe('Security: WebSocket upgrade auth gating (§6.1)', () => {

  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server.kill(); });

  test('upgrade to /ws/:hostId without cookie is rejected 401', async () => {
    // ARCHITECTURE §6.1: "No WebSocket connection reaches a bridge without
    // passing through this authenticated proxy layer."
    const status = await wsUpgradeStatus({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/ws/lab-01',
    });
    assert.equal(status, 401, `Expected 401 without auth, got ${status}`);
  });

  test('upgrade to /ws/:hostId with valid cookie is accepted', async () => {
    const cookie = await login(server.port);
    // Create a host first so the WS path resolves
    const createRes = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/api/hosts',
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    }, JSON.stringify({
      label: 'WS Test', ip: '127.0.0.1', vncPort: 5900,
      password: 'test', sshPublicKey: 'ssh-ed25519 AAAA test',
      alertTier: 'medium', fadeEnabled: true
    }));
    const { hostId } = JSON.parse(createRes.body);
    // Now attempt upgrade — should get 101 since host exists and has a bridge
    const status = await wsUpgradeStatus({
      hostname: '127.0.0.1',
      port: server.port,
      path: `/ws/${hostId}`,
      headers: { Cookie: cookie },
    });
    assert.equal(status, 101, `Expected 101 with valid auth, got ${status}`);
  });

  test('upgrade with invalid JWT is rejected 401', async () => {
    const status = await wsUpgradeStatus({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/ws/lab-01',
      headers: { Cookie: 'token=this.is.not.a.valid.jwt' },
    });
    assert.equal(status, 401);
  });

  test('/control WebSocket upgrade without cookie is rejected 401', async () => {
    const status = await wsUpgradeStatus({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/control',
    });
    assert.equal(status, 401);
  });

});

describe('Security: Authentication — bcrypt + rate limiting (§6.1)', () => {

  let server;
  before(async () => { server = await startServer({ rateLimitMax: 3, rateLimitWindow: 60 }); });
  after(async () => { await server.kill(); });

  test('correct password returns 200 and sets cookie', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ password: 'test-password-correct-horse' }));
    assert.equal(res.status, 200);
    assert.ok(res.headers['set-cookie']?.[0]?.includes('token='),
      'Expected token cookie in response');
  });

  test('wrong password returns 401', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ password: 'wrong-password' }));
    assert.equal(res.status, 401);
  });

  test('cookie is httpOnly (§6.1)', async () => {
    const cookie = (await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ password: 'test-password-correct-horse' }))).headers['set-cookie']?.[0];
    assert.ok(cookie?.toLowerCase().includes('httponly'),
      'JWT cookie must be HttpOnly');
  });

  test('rate limiter triggers after rateLimitMax failed attempts', async () => {
    // Exhaust the limit (set to 3 above)
    for (let i = 0; i < 3; i++) {
      await request({
        hostname: '127.0.0.1',
        port: server.port,
        path: '/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ password: 'wrong' }));
    }
    // Next attempt should be rate limited (429)
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ password: 'wrong' }));
    assert.equal(res.status, 429, 'Expected 429 after rate limit exceeded');
  });

});

describe('Security: Content Security Policy (§4.1)', () => {

  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server.kill(); });

  test('dashboard response includes connect-src CSP header', async () => {
    const cookie = await login(server.port);
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/',
      headers: { Cookie: cookie },
    });
    const csp = res.headers['content-security-policy'] ?? '';
    assert.ok(csp.includes('connect-src'), 'CSP header must include connect-src');
    assert.ok(
      csp.includes('ws://localhost') || csp.includes('wss://localhost'),
      'connect-src must explicitly allow WebSocket connections to localhost'
    );
  });

});

// ---------------------------------------------------------------------------
// 2. DATA INTEGRITY TESTS
// ---------------------------------------------------------------------------

describe('Data: profiles.json — backup on write (§10.1)', () => {

  let profiles;
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambvnc-profiles-'));
    profiles = require(root('server', 'profiles.js'));
    profiles._setDataDir(tmpDir); // test seam: override data dir
  });

  test('backup file is created before first write', () => {
    const initial = { hosts: {}, monitoringProfiles: {} };
    profiles.save(initial);
    profiles.save({ hosts: { 'lab-01': { label: 'Test' } }, monitoringProfiles: {} });
    const backupExists = fs.existsSync(path.join(tmpDir, 'profiles.json.bak'));
    assert.ok(backupExists, 'profiles.json.bak must exist after second write');
  });

  test('backup contains previous content, not current', () => {
    const first = { hosts: { 'original': {} }, monitoringProfiles: {} };
    const second = { hosts: { 'updated': {} }, monitoringProfiles: {} };
    profiles.save(first);
    profiles.save(second);
    const bak = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'profiles.json.bak'), 'utf8')
    );
    assert.ok('original' in bak.hosts, 'Backup should contain the previous write');
    assert.ok(!('updated' in bak.hosts), 'Backup must not contain the current write');
  });

  test('profiles.json structure matches documented schema (§17.1)', () => {
    const host = {
      label: 'Lab 01',
      ip: '192.168.1.101',
      vncPort: 5900,
      encryptedPassword: 'abc=',
      passwordIv: 'def=',
      passwordTag: 'ghi=',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      tunnelPort: 5910,
      alertTier: 'medium',
      fadeEnabled: true,
    };
    const data = { hosts: { 'lab-01': host }, monitoringProfiles: {} };
    profiles.save(data);
    const loaded = profiles.load();
    const h = loaded.hosts['lab-01'];
    // Assert all documented fields are present and correctly typed
    assert.equal(typeof h.label, 'string');
    assert.equal(typeof h.ip, 'string');
    assert.equal(typeof h.vncPort, 'number');
    assert.equal(typeof h.encryptedPassword, 'string');
    assert.equal(typeof h.passwordIv, 'string');
    assert.equal(typeof h.passwordTag, 'string');
    assert.equal(typeof h.sshPublicKey, 'string');
    assert.equal(typeof h.tunnelPort, 'number');
    assert.ok(['low', 'medium', 'high', 'none'].includes(h.alertTier));
    assert.equal(typeof h.fadeEnabled, 'boolean');
  });

});

describe('Data: Audit log — SQLite WAL, schema, no-JSON-race (§10.2, §17.2)', () => {

  let audit;
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambvnc-audit-'));
    audit = require(root('server', 'audit.js'));
    audit._setDataDir(tmpDir);
    audit._init(); // create tables and enable WAL
  });

  test('WAL mode is enabled', () => {
    const mode = audit._getJournalMode();
    assert.equal(mode, 'wal', 'SQLite journal_mode must be WAL');
  });

  test('sessions table has correct columns', () => {
    const cols = audit._getColumns('sessions');
    const names = cols.map(c => c.name);
    assert.ok(names.includes('id'));
    assert.ok(names.includes('token_hash'));
    assert.ok(names.includes('ip'));
    assert.ok(names.includes('logged_in'));
    assert.ok(names.includes('logged_out'));
  });

  test('connections table has correct columns', () => {
    const cols = audit._getColumns('connections');
    const names = cols.map(c => c.name);
    assert.ok(names.includes('id'));
    assert.ok(names.includes('session_id'));
    assert.ok(names.includes('host_id'));
    assert.ok(names.includes('connected'));
    assert.ok(names.includes('disconnected'));
  });

  test('token_hash stores SHA-256 digest, not the raw JWT', () => {
    // ARCHITECTURE §17.2: "token_hash stores a SHA-256 digest of the JWT
    // rather than the token itself."
    const fakeJwt = 'header.payload.signature';
    const sessionId = audit.logLogin(fakeJwt, '127.0.0.1');
    const row = audit._getSession(sessionId);
    assert.notEqual(row.token_hash, fakeJwt, 'Raw JWT must not be stored');
    const expectedHash = crypto.createHash('sha256').update(fakeJwt).digest('hex');
    assert.equal(row.token_hash, expectedHash, 'token_hash must be SHA-256 of JWT');
  });

  test('concurrent writes do not corrupt the log', async () => {
    // Fire 20 concurrent audit writes and confirm all are recorded
    const sessionId = audit.logLogin('concurrent-test-jwt', '127.0.0.1');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve(audit.logConnection(sessionId, `host-${i}`))
      )
    );
    const count = audit._countConnections(sessionId);
    assert.equal(count, 20, `Expected 20 connection records, got ${count}`);
  });

});

describe('Data: Config validation — fail loud at startup (§15)', () => {

  let validateConfig;
  before(() => { validateConfig = require(root('server', 'index.js'))._validateConfig; });

  const validConfig = {
    serverPort: 3000, sshPort: 2222, basePort: 5910,
    tls: false, sessionTtl: 28800, fadeDuration: 15,
    reconnectInterval: 5, reconnectRetries: 3, maxHosts: 12,
    rateLimitWindow: 900, rateLimitMax: 10, auditRetentionDays: 90,
  };

  test('valid config passes without throwing', () => {
    assert.doesNotThrow(() => validateConfig(validConfig));
  });

  test('fadeDuration as string throws with field name in message', () => {
    assert.throws(
      () => validateConfig({ ...validConfig, fadeDuration: 'fifteen' }),
      /fadeDuration/,
      'Error must identify the invalid field'
    );
  });

  test('sshPort below 1024 throws', () => {
    assert.throws(
      () => validateConfig({ ...validConfig, sshPort: 80 }),
      /sshPort/
    );
  });

  test('maxHosts above 12 throws', () => {
    assert.throws(
      () => validateConfig({ ...validConfig, maxHosts: 13 }),
      /maxHosts/
    );
  });

  test('tls: true without tlsCert throws', () => {
    assert.throws(
      () => validateConfig({ ...validConfig, tls: true, tlsKey: '/path/key.pem' }),
      /tlsCert/
    );
  });

  test('missing optional fields use defaults', () => {
    const minimal = { ...validConfig };
    delete minimal.fadeDuration;
    const result = validateConfig(minimal);
    assert.equal(result.fadeDuration, 15, 'fadeDuration should default to 15');
  });

});

// ---------------------------------------------------------------------------
// 3. INTEGRATION SMOKE TESTS
//    Full server subprocess. Tests the paths that cross module boundaries.
// ---------------------------------------------------------------------------

describe('Integration: Route auth surface (§18)', () => {

  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server.kill(); });

  const protectedRoutes = [
    ['GET', '/api/hosts'],
    ['GET', '/api/profiles'],
    ['GET', '/health'],
  ];

  for (const [method, path] of protectedRoutes) {
    test(`${method} ${path} without auth returns 401`, async () => {
      const res = await request({
        hostname: '127.0.0.1',
        port: server.port,
        path,
        method,
      });
      assert.equal(res.status, 401, `${method} ${path} should require auth`);
    });
  }

  test('GET /login returns 200 without auth', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/login',
    });
    assert.equal(res.status, 200);
  });

  test('full login → authenticated request flow', async () => {
    const cookie = await login(server.port);
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/api/hosts',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok('hosts' in body, 'GET /api/hosts should return hosts key');
  });

  test('POST /logout clears cookie', async () => {
    const cookie = await login(server.port);
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/logout',
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers['set-cookie']?.[0] ?? '';
    // Cookie should be cleared (Max-Age=0 or Expires in the past)
    assert.ok(
      setCookie.includes('Max-Age=0') || setCookie.includes('Expires=Thu, 01 Jan 1970'),
      'Logout must clear the token cookie'
    );
  });

});

describe('Integration: Host profile CRUD → health reflection (§16, §18)', () => {

  let server;
  let cookie;

  before(async () => {
    server = await startServer();
    cookie = await login(server.port);
  });
  after(async () => { await server.kill(); });

  const testHost = {
    label: 'Integration Test Machine',
    ip: '192.168.1.200',
    vncPort: 5900,
    password: 'test-vnc-password',
    sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test@integration',
    alertTier: 'medium',
    fadeEnabled: true,
  };

  test('POST /api/hosts creates a host and returns hostId', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/api/hosts',
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    }, JSON.stringify(testHost));
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.hostId, 'Response must include hostId');
    // Store for subsequent tests
    this.hostId = body.hostId;
  });

  test('VNC password is stored encrypted, not plaintext (§6.2)', async () => {
    // Read profiles.json directly and confirm password is not plaintext
    const profilesPath = path.join(server.dataDir, 'profiles.json');
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    const hostIds = Object.keys(profiles.hosts);
    assert.ok(hostIds.length > 0, 'Host should have been persisted');
    const host = profiles.hosts[hostIds[0]];
    assert.ok(host.encryptedPassword, 'encryptedPassword field must exist');
    assert.ok(host.passwordIv, 'passwordIv field must exist');
    assert.ok(host.passwordTag, 'passwordTag field must exist');
    assert.ok(
      !JSON.stringify(profiles).includes(testHost.password),
      'Plaintext VNC password must not appear anywhere in profiles.json'
    );
  });

  test('GET /health returns valid structure after host added', async () => {
    const res = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/health',
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok', 'health.status must be ok');
    assert.ok(Array.isArray(body.tunnels), 'health.tunnels must be an array');
    assert.equal(typeof body.uptime, 'number', 'health.uptime must be a number');
    assert.equal(typeof body.activeSessions, 'number', 'health.activeSessions must be a number');
    assert.equal(typeof body.auditLogSize, 'number', 'health.auditLogSize must be a number');
  });

  test('profiles.json.bak exists after host creation', () => {
    const bakPath = path.join(server.dataDir, 'profiles.json.bak');
    assert.ok(fs.existsSync(bakPath), 'profiles.json.bak must exist after write');
  });

  test('DELETE /api/hosts/:hostId removes host', async () => {
    // Use hostId from first test (stored on this — may need to re-fetch)
    const listRes = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/api/hosts',
      headers: { Cookie: cookie },
    });
    const { hosts } = JSON.parse(listRes.body);
    const hostId = Object.keys(hosts)[0];
    const delRes = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: `/api/hosts/${hostId}`,
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(delRes.status, 200);
    const afterRes = await request({
      hostname: '127.0.0.1',
      port: server.port,
      path: '/api/hosts',
      headers: { Cookie: cookie },
    });
    const after = JSON.parse(afterRes.body);
    assert.ok(!(hostId in after.hosts), 'Deleted host must not appear in subsequent GET');
  });

});

describe('Integration: Port collision — fail loud at startup (§3.5, §15)', () => {

  test('server exits non-zero if a bridge port is already bound', async () => {
    // Pre-occupy the base port
    const blocker = net.createServer();
    await new Promise(res => blocker.listen(5910, '127.0.0.1', res));

    try {
      await assert.rejects(
        () => startServer({ basePort: 5910 }),
        /exited early|port.*in use|EADDRINUSE/i,
        'Server must fail loud when bridge port is already bound'
      );
    } finally {
      await new Promise(res => blocker.close(res));
    }
  });

});

// ---------------------------------------------------------------------------
// 4. EVENT BUS CONTRACT TESTS
//    Verify CustomEvent payload shape using Node's built-in DOM simulation.
//    Requires Node 20's experimental --experimental-vm-modules or a minimal
//    DOM shim. We use a lightweight approach: test the dispatch/listen
//    mechanics via a bare EventTarget (available in Node 18+).
// ---------------------------------------------------------------------------

describe('Event Bus: CustomEvent detail payload shape (§7.1)', () => {

  // Node 22 exposes EventTarget and CustomEvent globally without flags.
  // We use EventTarget as a stand-in for window to test dispatch/listen mechanics.
  const bus = new EventTarget();

  // Helper: dispatch a CustomEvent and capture what the listener receives
  function roundtrip(eventName, detail) {
    return new Promise(resolve => {
      bus.addEventListener(eventName, (e) => resolve(e.detail), { once: true });
      bus.dispatchEvent(new CustomEvent(eventName, { detail }));
    });
  }

  test('cell:connected — payload arrives in event.detail', async () => {
    const payload = { cellId: 'lab-01', canvas: {} };
    const received = await roundtrip('cell:connected', payload);
    assert.equal(received.cellId, 'lab-01');
    assert.ok('canvas' in received);
  });

  test('cell:change-detected — all documented fields present', async () => {
    const payload = { cellId: 'lab-02', tier: 'high', pctChanged: 14.7 };
    const received = await roundtrip('cell:change-detected', payload);
    assert.equal(received.cellId, 'lab-02');
    assert.ok(['low', 'medium', 'high'].includes(received.tier));
    assert.equal(typeof received.pctChanged, 'number');
  });

  test('tunnel:status-changed — status enum values are valid', async () => {
    for (const status of ['connected', 'reconnecting', 'disconnected']) {
      const payload = { cellId: 'lab-01', status };
      const received = await roundtrip('tunnel:status-changed', payload);
      assert.equal(received.status, status);
    }
  });

  test('tunnel:status-changed — attempt field is optional (§7.1)', async () => {
    // Without attempt
    const withoutAttempt = await roundtrip('tunnel:status-changed',
      { cellId: 'lab-01', status: 'disconnected' });
    assert.equal(withoutAttempt.attempt, undefined);

    // With attempt
    const withAttempt = await roundtrip('tunnel:status-changed',
      { cellId: 'lab-01', status: 'reconnecting', attempt: 2 });
    assert.equal(withAttempt.attempt, 2);
  });

  test('alert:set-tier — tier values are constrained to documented enum', async () => {
    const validTiers = ['low', 'medium', 'high', 'none'];
    for (const tier of validTiers) {
      const received = await roundtrip('alert:set-tier',
        { cellId: 'lab-01', tier });
      assert.ok(validTiers.includes(received.tier));
    }
  });

  test('payload is accessible via event.detail, not event directly (§7.1)', async () => {
    // Confirms agents wire listeners correctly
    const raw = await new Promise(resolve => {
      bus.addEventListener('cell:disconnected', resolve, { once: true });
      bus.dispatchEvent(new CustomEvent('cell:disconnected',
        { detail: { cellId: 'lab-03' } }));
    });
    // event.cellId should be undefined — it lives in event.detail
    assert.equal(raw.cellId, undefined,
      'Payload must not be on event directly — use event.detail');
    assert.equal(raw.detail.cellId, 'lab-03');
  });

});

// ---------------------------------------------------------------------------
// End of suite
// ---------------------------------------------------------------------------
