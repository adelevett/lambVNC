const fs = require('fs');
const path = require('path');
const tunnels = require('./tunnels');
const crypto = require('./crypto');

let DATA_DIR = path.join(__dirname, '..', 'data');
let PROFILES_PATH = path.join(DATA_DIR, 'profiles.json');
let BACKUP_PATH = path.join(DATA_DIR, 'profiles.json.bak');

/**
 * Test seam: override data directory
 * @param {string} dir
 */
function _setDataDir(dir) {
  DATA_DIR = dir;
  PROFILES_PATH = path.join(dir, 'profiles.json');
  BACKUP_PATH = path.join(dir, 'profiles.json.bak');
}

/**
 * Ensures the profiles file exists
 */
function ensureProfiles() {
  if (!fs.existsSync(PROFILES_PATH)) {
    const defaultData = {
      hosts: {},
      monitoringProfiles: {}
    };
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(defaultData, null, 2));
  }
}

/**
 * Loads profiles from disk
 * @returns {Object}
 */
function load() {
  ensureProfiles();
  const data = fs.readFileSync(PROFILES_PATH, 'utf8');
  return JSON.parse(data);
}

/**
 * Saves profiles to disk with atomic backup
 * @param {Object} profiles
 */
function save(profiles) {
  if (fs.existsSync(PROFILES_PATH)) {
    fs.copyFileSync(PROFILES_PATH, BACKUP_PATH);
  }
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

/**
 * Gets a list of hosts for API (strips secrets, adds tunnelState)
 * @param {Object} [config] - optional server config to include fadeDuration
 * @returns {Object}
 */
function getHosts(config) {
  const profiles = load();
  const hosts = {};

  for (const hostId in profiles.hosts) {
    const host = { ...profiles.hosts[hostId] };
    // SPEC: Strip secrets from API response
    delete host.encryptedPassword;
    delete host.passwordIv;
    delete host.passwordTag;

    // SPEC: Include each host's current tunnel state (field name: tunnelState)
    const state = tunnels.tunnelStates.get(hostId);
    host.tunnelState = state ? state.state : 'disconnected';

    hosts[hostId] = host;
  }

  const result = { hosts };
  if (config) {
    result.fadeDuration = (config.fadeDuration || 15) * 1000;
    result.maxHosts = config.maxHosts || 12;
    result.sshPort = config.sshPort || 2222;
  }
  return result;
}

/**
 * Gets raw hosts with secrets for internal server use
 * @returns {Object}
 */
function getRawHosts() {
  const profiles = load();
  return profiles.hosts;
}

/**
 * Gets a host by ID (raw, with secrets — for internal use)
 * @param {string} hostId
 * @returns {Object|null}
 */
function getHost(hostId) {
  const hosts = getRawHosts();
  return hosts[hostId] || null;
}

/**
 * Adds or updates a host
 * @param {string} hostId
 * @param {Object} hostData
 */
function updateHost(hostId, hostData) {
  const profiles = load();

  // SPEC: Encrypt password if provided
  if (hostData.password) {
    const { encrypted, iv, tag } = crypto.encryptPassword(hostData.password);
    hostData.encryptedPassword = encrypted;
    hostData.passwordIv = iv;
    hostData.passwordTag = tag;
    delete hostData.password;
  }

  profiles.hosts[hostId] = {
    ...profiles.hosts[hostId],
    ...hostData
  };
  save(profiles);
}

/**
 * Removes a host
 * @param {string} hostId
 */
function removeHost(hostId) {
  const profiles = load();
  delete profiles.hosts[hostId];
  save(profiles);
}

/**
 * Gets monitoring profiles
 * @returns {Object}
 */
function getMonitoringProfiles() {
  const profiles = load();
  return profiles.monitoringProfiles;
}

/**
 * Adds or updates a monitoring profile
 * @param {string} profileId
 * @param {Object} profileData
 */
function updateMonitoringProfile(profileId, profileData) {
  const profiles = load();
  profiles.monitoringProfiles[profileId] = {
    ...profiles.monitoringProfiles[profileId],
    ...profileData
  };
  save(profiles);
}

/**
 * Removes a monitoring profile
 * @param {string} profileId
 */
function removeMonitoringProfile(profileId) {
  const profiles = load();
  delete profiles.monitoringProfiles[profileId];
  save(profiles);
}

module.exports = {
  _setDataDir,
  load,
  save,
  getHosts,
  getRawHosts,
  getHost,
  updateHost,
  removeHost,
  getMonitoringProfiles,
  updateMonitoringProfile,
  removeMonitoringProfile
};
