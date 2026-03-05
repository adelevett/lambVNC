const { Server, utils } = require('ssh2');
const fs = require('fs');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

// Lazy require to break circular dependency: profiles ↔ tunnels
let _profiles;
function profiles() {
  if (!_profiles) _profiles = require('./profiles');
  return _profiles;
}

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

// TCP servers bound per host for SSH -R port forwarding
const tunnelServers = new Map(); // hostId -> net.Server

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

      const hosts = profiles().getRawHosts();
      for (const id in hosts) {
        const host = hosts[id];
        if (!host.sshPublicKey) continue;
        // Parse the stored OpenSSH format key into its binary representation
        const parsed = utils.parseKey(host.sshPublicKey);
        if (parsed instanceof Error) continue;
        // ctx.key.data is the raw public key blob from the SSH packet;
        // parsed.getPublicSSH() returns the same binary format
        if (ctx.key.data.equals(parsed.getPublicSSH())) {
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
        // SSH auth succeeded, but the reverse port may not be bound yet.
        state: 'reconnecting',
        attempts: 0,
        since: Math.floor(Date.now() / 1000)
      });

      broadcastStatus(hostId, 'reconnecting', 0);

      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const hosts = profiles().getRawHosts();
          const host = hosts[hostId];
          if (info.bindAddr === '127.0.0.1' && info.bindPort === host.tunnelPort) {
            accept();

            // Bind a real TCP socket so proxy.js can connect to it.
            // Each incoming TCP connection is forwarded through the SSH channel
            // back to the sender's VNC port.
            const tcpServer = net.createServer((sock) => {
              client.forwardOut(
                info.bindAddr, info.bindPort,
                sock.remoteAddress || '127.0.0.1', sock.remotePort || 0,
                (err, channel) => {
                  if (err) {
                    console.error(`forwardOut error for ${hostId}:`, err.message);
                    sock.destroy();
                    return;
                  }
                  sock.pipe(channel);
                  channel.pipe(sock);
                  sock.on('error', () => channel.destroy());
                  channel.on('error', () => sock.destroy());
                  channel.on('close', () => sock.destroy());
                  sock.on('close', () => channel.destroy());
                }
              );
            });

            tcpServer.listen(info.bindPort, info.bindAddr, () => {
              tunnelStates.set(hostId, {
                state: 'connected',
                attempts: 0,
                since: Math.floor(Date.now() / 1000),
                timer: null
              });
              broadcastStatus(hostId, 'connected', 0);
            });
            tcpServer.on('error', (err) =>
              console.error(`Tunnel TCP server error for ${hostId}:`, err.message)
            );

            // Replace any stale server from a previous connection.
            const old = tunnelServers.get(hostId);
            if (old) old.close();
            tunnelServers.set(hostId, tcpServer);

          } else {
            reject();
          }
        } else if (name === 'cancel-tcpip-forward') {
          const srv = tunnelServers.get(hostId);
          if (srv) { srv.close(); tunnelServers.delete(hostId); }
          accept();
        }
      });
    }).on('close', () => {
      if (!hostId) return;

      // Tear down the TCP server bound for this host's tunnel.
      const srv = tunnelServers.get(hostId);
      if (srv) { srv.close(); tunnelServers.delete(hostId); }

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

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const port = config.sshPort ?? 2222;
      console.error('\x1b[31m%s\x1b[0m', `Startup Failure: SSH port ${port} is already in use.`);
      console.error('\x1b[31m%s\x1b[0m', `Change sshPort in config.json or free port ${port} before starting LambVNC.`);
    } else {
      console.error('\x1b[31m%s\x1b[0m', `SSH server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(config.sshPort ?? 2222, '0.0.0.0', () => {
    console.log(`SSH server listening on port ${server.address().port}`);
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
