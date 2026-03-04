const { Server } = require('ssh2');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const profiles = require('./profiles');

let DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * Test seam: override data directory
 * @param {string} dir
 */
function _setDataDir(dir) {
  DATA_DIR = dir;
}

/**
 * Gets or generates the SSH host key
 * @returns {Buffer}
 */
function getHostKey() {
  const hostKeyPath = path.join(DATA_DIR, 'host.key');
  if (!fs.existsSync(hostKeyPath)) {
    const { utils } = require('ssh2');
    const keys = utils.generateKeyPairSync('ed25519');
    fs.writeFileSync(hostKeyPath, keys.private);
    console.warn('\x1b[33m%s\x1b[0m', '⚠  LambVNC: SSH host key generated at data/host.key');
    console.warn('\x1b[33m%s\x1b[0m', '   Back up data/host.key to a secure location now.');
    return keys.private;
  }
  return fs.readFileSync(hostKeyPath);
}

// SPEC: Tunnel state machine Map MUST be exported
const tunnelStates = new Map(); // hostId -> { state, attempts, since, timer }

// Control WebSocket clients
const controlClients = new Set();

/**
 * Broadcasts tunnel status to all control clients
 * @param {string} hostId 
 * @param {string} status 
 * @param {number} attempt 
 */
function broadcastStatus(hostId, status, attempt = 0) {
  const payload = JSON.stringify({
    type: 'tunnel:status-changed',
    detail: { cellId: hostId, status, attempt }
  });

  for (const client of controlClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/**
 * Starts the embedded SSH server
 * @param {Object} config 
 */
function startSshServer(config) {
  const hostKey = getHostKey();

  const server = new Server({
    hostKeys: [hostKey]
  }, (client) => {
    let hostId = null;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') {
        return ctx.reject(['publickey']);
      }

      const hosts = profiles.getRawHosts();
      for (const id in hosts) {
        const host = hosts[id];
        if (host.sshPublicKey && host.sshPublicKey.includes(ctx.key.data.toString('base64'))) {
          hostId = id;
          return ctx.accept();
        }
      }

      ctx.reject();
    }).on('ready', () => {
      if (!hostId) return client.end();

      const state = tunnelStates.get(hostId) || {};
      if (state.timer) clearTimeout(state.timer);

      tunnelStates.set(hostId, {
        state: 'connected',
        attempts: 0,
        since: Math.floor(Date.now() / 1000)
      });

      broadcastStatus(hostId, 'connected');

      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const hosts = profiles.getRawHosts();
          const host = hosts[hostId];
          if (info.bindAddr === '127.0.0.1' && info.bindPort === host.tunnelPort) {
            accept();
          } else {
            reject();
          }
        }
      });
    }).on('close', () => {
      if (!hostId) return;

      // SPEC: Progressive retry with escalation to disconnected after 3 intervals
      const maxRetries = config.reconnectRetries || 3;
      const interval = (config.reconnectInterval || 5) * 1000;

      const state = tunnelStates.get(hostId) || { attempts: 0 };

      const retry = () => {
        state.attempts++;
        if (state.attempts >= maxRetries) {
          state.state = 'disconnected';
          broadcastStatus(hostId, 'disconnected');
          tunnelStates.set(hostId, { ...state, timer: null });
        } else {
          state.state = 'reconnecting';
          broadcastStatus(hostId, 'reconnecting', state.attempts);
          state.timer = setTimeout(retry, interval);
          tunnelStates.set(hostId, state);
        }
      };

      // Start the retry sequence after the first interval
      state.state = 'reconnecting';
      broadcastStatus(hostId, 'reconnecting', state.attempts);
      state.timer = setTimeout(retry, interval);
      tunnelStates.set(hostId, state);
    });
  });

  server.listen(config.sshPort || 2222, '0.0.0.0', () => {
    console.log(`SSH server listening on port ${config.sshPort || 2222}`);
  });
}

/**
 * Adds a control client
 * @param {WebSocket} ws 
 */
function addControlClient(ws) {
  controlClients.add(ws);
  ws.on('close', () => controlClients.delete(ws));

  for (const [hostId, state] of tunnelStates) {
    ws.send(JSON.stringify({
      type: 'tunnel:status-changed',
      detail: { cellId: hostId, status: state.state, attempt: state.attempts }
    }));
  }
}

module.exports = {
  _setDataDir,
  startSshServer,
  addControlClient,
  tunnelStates
};
