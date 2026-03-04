const tunnels = require('./tunnels');
const audit = require('./audit');
const profiles = require('./profiles');

/**
 * Health endpoint handler
 * GET /health — authenticated
 */
function getHealth(req, res) {
  const uptime = Math.floor(process.uptime());
  const auditLogSize = audit.getAuditLogSize();
  const activeSessions = audit.getActiveSessionCount();

  // Build tunnel list from the exported tunnelStates Map
  const rawHosts = profiles.getRawHosts();
  const tunnelList = [];
  for (const [hostId, state] of tunnels.tunnelStates) {
    const host = rawHosts[hostId];
    tunnelList.push({
      hostId,
      state: state.state,
      bridgePort: host ? host.tunnelPort : null,
      since: state.since || null,
      attempt: state.attempts || 0
    });
  }

  res.json({
    status: 'ok',
    uptime,
    tunnels: tunnelList,
    activeSessions,
    auditLogSize
  });
}

module.exports = {
  getHealth
};
