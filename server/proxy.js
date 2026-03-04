const WebSocket = require('ws');
const net = require('net');

/**
 * Creates a WS↔TCP bridge instance for a host.
 * @param {string} hostId 
 * @param {number} tunnelPort 
 */
function createBridge(hostId, tunnelPort) {
  // Bridges are not directly exposed to the network.
  // Express handles the upgrade and proxies to this internal WSS.
  const wss = new WebSocket.Server({ noServer: true });

  wss.on('connection', (ws) => {
    const tcp = net.createConnection({
      port: tunnelPort,
      host: '127.0.0.1'
    });

    ws.on('message', (data) => {
      if (tcp.writable) {
        tcp.write(data);
      }
    });

    tcp.on('data', (data) => {
      // CRITICAL: Must use { binary: true } to prevent RFB frame corruption
      ws.send(data, { binary: true });
    });

    ws.on('close', () => {
      tcp.destroy();
    });

    tcp.on('close', () => {
      ws.close();
    });

    tcp.on('error', (err) => {
      console.error(`Bridge TCP error for ${hostId}:`, err.message);
      ws.close();
    });

    ws.on('error', (err) => {
      console.error(`Bridge WS error for ${hostId}:`, err.message);
      tcp.destroy();
    });
  });

  return wss;
}

// Map of hostId to bridge instance
const bridges = new Map();

/**
 * Gets or creates a bridge for a host.
 * @param {string} hostId 
 * @param {number} tunnelPort 
 * @returns {WebSocket.Server}
 */
function getBridge(hostId, tunnelPort) {
  if (!bridges.has(hostId)) {
    bridges.set(hostId, createBridge(hostId, tunnelPort));
  }
  return bridges.get(hostId);
}

/**
 * Evicts a cached bridge when a host is deleted.
 * Closes all active WebSocket connections on the bridge.
 * @param {string} hostId
 */
function evictBridge(hostId) {
  const bridge = bridges.get(hostId);
  if (bridge) {
    bridge.clients.forEach(ws => ws.close());
    bridges.delete(hostId);
  }
}

module.exports = {
  getBridge,
  evictBridge
};
