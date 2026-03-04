const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const read = require('read');

// ---------------------------------------------------------------------------
// CLI flag: --config <path> (for test subprocess isolation)
// ---------------------------------------------------------------------------
let configPathOverride = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) {
    configPathOverride = args[i + 1];
    break;
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------
const CONFIG_PATH = configPathOverride || path.join(__dirname, '..', 'config.json');
let rawConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('\x1b[31m%s\x1b[0m', `Startup Failure: config.json is not valid JSON — ${err.message}`);
    process.exit(1);
  }
} else if (!configPathOverride) {
  console.warn('\x1b[33m%s\x1b[0m', '⚠  No config.json found — using all defaults.');
}

// ---------------------------------------------------------------------------
// Config validation — pure function, exported for testing
// ---------------------------------------------------------------------------
/**
 * Validates a config object and returns it with defaults applied.
 * Throws on invalid values. Does not mutate the input.
 * @param {Object} input
 * @returns {Object} validated config with defaults
 */
function _validateConfig(input) {
  const defaults = {
    serverPort: 3000,
    sshPort: 2222,
    basePort: 5910,
    tls: false,
    sessionTtl: 28800,
    fadeDuration: 15,
    reconnectInterval: 5,
    reconnectRetries: 3,
    maxHosts: 12,
    rateLimitWindow: 900,
    rateLimitMax: 10,
    auditRetentionDays: 90
  };

  const config = { ...defaults, ...input };

  const checkInt = (val, name, min, max) => {
    if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max) {
      throw new Error(`config.${name} must be an integer between ${min} and ${max}, got: ${val}`);
    }
  };
  const checkBool = (val, name) => {
    if (typeof val !== 'boolean') {
      throw new Error(`config.${name} must be a boolean, got: ${typeof val}`);
    }
  };

  // serverPort/sshPort: 0 = OS-assigned (legitimate for test subprocesses), 1024-65535 = valid
  const checkListenPort = (val, name) => {
    if (typeof val !== 'number' || !Number.isInteger(val)) {
      throw new Error(`config.${name} must be an integer, got: ${val}`);
    }
    if (val !== 0 && (val < 1024 || val > 65535)) {
      throw new Error(`config.${name} must be 0 (OS-assigned) or between 1024 and 65535, got: ${val}`);
    }
  };

  checkListenPort(config.serverPort, 'serverPort');
  checkListenPort(config.sshPort, 'sshPort');
  // basePort defines a pre-allocated range, not a listen socket — 0 is not valid (§15)
  checkInt(config.basePort, 'basePort', 1024, 65535);
  checkInt(config.sessionTtl, 'sessionTtl', 1, 604800);
  checkInt(config.fadeDuration, 'fadeDuration', 1, 300);
  checkInt(config.reconnectInterval, 'reconnectInterval', 1, 60);
  checkInt(config.reconnectRetries, 'reconnectRetries', 1, 10);
  checkInt(config.maxHosts, 'maxHosts', 1, 12);
  checkInt(config.rateLimitWindow, 'rateLimitWindow', 1, 86400);
  checkInt(config.rateLimitMax, 'rateLimitMax', 1, 1000);
  checkInt(config.auditRetentionDays, 'auditRetentionDays', 1, 3650);
  checkBool(config.tls, 'tls');

  // Port overlap check (skip if OS-assigned)
  if (config.serverPort !== 0 && config.sshPort !== 0) {
    if (config.serverPort === config.sshPort) {
      throw new Error(`config.serverPort (${config.serverPort}) must not equal config.sshPort (${config.sshPort})`);
    }
  }
  if (config.basePort !== 0 && config.serverPort !== 0 && config.basePort === config.serverPort) {
    throw new Error(`config.basePort (${config.basePort}) must not overlap with serverPort`);
  }
  if (config.basePort !== 0 && config.sshPort !== 0 && config.basePort === config.sshPort) {
    throw new Error(`config.basePort (${config.basePort}) must not overlap with sshPort`);
  }

  // TLS conditional validation
  if (config.tls) {
    if (typeof config.tlsCert !== 'string' || !config.tlsCert) {
      throw new Error('config.tlsCert is required when tls is true');
    }
    if (typeof config.tlsKey !== 'string' || !config.tlsKey) {
      throw new Error('config.tlsKey is required when tls is true');
    }
    if (!fs.existsSync(config.tlsCert)) {
      throw new Error(`config.tlsCert file not found: ${config.tlsCert}`);
    }
    if (!fs.existsSync(config.tlsKey)) {
      throw new Error(`config.tlsKey file not found: ${config.tlsKey}`);
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Resolve data directory (_dataDir override for test isolation)
// ---------------------------------------------------------------------------
const DATA_DIR = rawConfig._dataDir || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// If custom data directory, tell all data-owning modules
const profiles = require('./profiles');
const audit = require('./audit');
const auth = require('./auth');
const lambCrypto = require('./crypto');
const ports = require('./ports');
const tunnels = require('./tunnels');
const proxy = require('./proxy');
const health = require('./health');

if (rawConfig._dataDir) {
  profiles._setDataDir(DATA_DIR);
  audit._setDataDir(DATA_DIR);
  auth._setDataDir(DATA_DIR);
  lambCrypto._setDataDir(DATA_DIR);
  tunnels._setDataDir(DATA_DIR);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// SPEC §4.1: Content Security Policy on every response
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    `connect-src 'self' ws://localhost:* wss://localhost:*`
  );
  next();
});

/**
 * First-run bootstrap — ARCHITECTURE.md §19
 */
async function bootstrap(config) {
  audit.initDb();

  const HASH_PATH = path.join(DATA_DIR, 'admin.hash');
  if (!fs.existsSync(HASH_PATH)) {
    // Test mode: use env var instead of interactive prompt
    if (rawConfig._testMode && process.env.LAMBVNC_TEST_PASSWORD) {
      const password = process.env.LAMBVNC_TEST_PASSWORD;
      fs.writeFileSync(HASH_PATH, bcrypt.hashSync(password, 12));
      console.log('✓ Test mode: password set from LAMBVNC_TEST_PASSWORD.');
    } else {
      console.log('\n\x1b[36m%s\x1b[0m', 'LambVNC first run — set administrator password:');
      const password = await new Promise(r => read({ prompt: 'Password: ', silent: true }, (e, res) => r(res)));
      const confirm = await new Promise(r => read({ prompt: 'Confirm:  ', silent: true }, (e, res) => r(res)));
      if (password !== confirm) {
        console.error('\x1b[31m%s\x1b[0m', 'Passwords do not match.');
        process.exit(1);
      }
      fs.writeFileSync(HASH_PATH, bcrypt.hashSync(password, 12));
      console.log('✓ Password set. Starting server...\n');
    }
  }

  audit.pruneAuditLog(config.auditRetentionDays || 90);
}

// --- Routes ---
// Unauthenticated routes
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../client/login.html')));

// Auth middleware — everything below requires valid JWT
// (login POST and logout are placed before middleware)

// --- Routes setup (deferred until config is validated in startup) ---
function setupRoutes(config) {
  app.post('/login', auth.createAuthLimiter(config), auth.handleLogin(config));
  app.post('/logout', auth.handleLogout);

  app.use(auth.authMiddleware);

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));
  app.use('/client', express.static(path.join(__dirname, '../client')));

  app.get('/health', health.getHealth);

  // Host CRUD — ARCHITECTURE.md §18
  app.get('/api/hosts', (req, res) => res.json(profiles.getHosts(config)));
  app.post('/api/hosts', (req, res) => {
    const hostId = `host-${Date.now()}`;
    const tunnelPort = ports.allocateNextPort(config.basePort);
    profiles.updateHost(hostId, { ...req.body, tunnelPort });
    res.status(201).json({ success: true, hostId });
  });
  app.put('/api/hosts/:hostId', (req, res) => {
    profiles.updateHost(req.params.hostId, req.body);
    res.json({ success: true });
  });
  app.delete('/api/hosts/:hostId', (req, res) => {
    profiles.removeHost(req.params.hostId);
    res.json({ success: true });
  });

  // Profile CRUD
  app.get('/api/profiles', (req, res) => res.json(profiles.getMonitoringProfiles()));
  app.post('/api/profiles', (req, res) => {
    const profileId = `profile-${Date.now()}`;
    profiles.updateMonitoringProfile(profileId, req.body);
    res.json({ success: true, profileId });
  });
  app.put('/api/profiles/:profileId', (req, res) => {
    profiles.updateMonitoringProfile(req.params.profileId, req.body);
    res.json({ success: true });
  });
  app.delete('/api/profiles/:profileId', (req, res) => {
    profiles.removeMonitoringProfile(req.params.profileId);
    res.json({ success: true });
  });
}

// WebSocket upgrade handling — ARCHITECTURE.md §6.1
const wssControl = new (require('ws').Server)({ noServer: true });
wssControl.on('connection', (ws) => tunnels.addControlClient(ws));

if (require.main === module) {
  (async () => {
    try {
      const config = _validateConfig(rawConfig);

      await bootstrap(config);
      await ports.validateAllPorts(config.basePort);

      setupRoutes(config);

      // SPEC §5: Support TLS if configured
      const server = config.tls ?
        require('https').createServer({
          cert: fs.readFileSync(config.tlsCert),
          key: fs.readFileSync(config.tlsKey)
        }, app) :
        http.createServer(app);

      server.on('upgrade', (req, socket, head) => {
        const cookies = auth.parseCookies(req.headers.cookie);
        const token = cookies.token;
        if (!token || !auth.verifyToken(token)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/control') {
          wssControl.handleUpgrade(req, socket, head, (ws) => wssControl.emit('connection', ws, req));
        } else if (url.pathname.startsWith('/ws/')) {
          const hostId = url.pathname.split('/')[2];
          const host = profiles.getRawHosts()[hostId];
          if (host && host.tunnelPort) {
            const bridge = proxy.getBridge(hostId, host.tunnelPort);
            bridge.handleUpgrade(req, socket, head, ws => {
              // SPEC §10.2: Record per-host connection in audit log
              const sessionRow = audit.getSessionByToken(token);
              const sessionId = sessionRow ? sessionRow.id : null;
              const connectionId = sessionId ? audit.logConnection(sessionId, hostId) : null;
              ws.on('close', () => {
                if (connectionId) audit.logDisconnection(connectionId);
              });
              bridge.emit('connection', ws, req);
            });
          } else {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
          }
        } else {
          socket.destroy();
        }
      });

      tunnels.startSshServer(config);

      server.listen(config.serverPort, () => {
        const actualPort = server.address().port;
        console.log(`LambVNC listening on port ${actualPort}`);
      });
    } catch (err) {
      console.error(`\x1b[31m%s\x1b[0m`, `Startup Failure: ${err.message}`);
      process.exit(1);
    }
  })();
}

// Export for testing
module.exports = { _validateConfig };
