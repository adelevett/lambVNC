const net = require('net');
const profiles = require('./profiles');

/**
 * Allocates a new tunnel port for a host
 * @param {number} basePort 
 * @returns {number}
 */
function allocateNextPort(basePort) {
  const hosts = profiles.getHosts();
  const usedPorts = Object.values(hosts).map(h => h.tunnelPort).filter(p => !!p);

  let port = basePort;
  while (usedPorts.includes(port)) {
    port++;
  }

  return port;
}

/**
 * Checks if a port is in use (async helper for index.js)
 * @param {number} port 
 * @returns {Promise<boolean>}
 */
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Full synchronous-looking validation for index.js startup
 * @param {number} basePort 
 */
async function validateAllPorts(basePort) {
  if (basePort === 0) return; // OS-assigned — nothing to validate

  const hosts = profiles.getHosts();
  const allocatedPorts = Object.values(hosts).map(h => h.tunnelPort).filter(p => !!p);

  // Always validate the basePort itself (the next port that would be allocated)
  const portsToCheck = new Set([basePort, ...allocatedPorts]);

  for (const port of portsToCheck) {
    const inUse = await checkPortInUse(port);
    if (inUse) {
      console.error(`\x1b[31m%s\x1b[0m`, `CRITICAL: Port ${port} is already in use.`);
      console.error(`\x1b[31m%s\x1b[0m`, `This port is pre-allocated for a host in profiles.json.`);
      process.exit(1);
    }
  }
}

module.exports = {
  validateAllPorts,
  allocateNextPort
};
