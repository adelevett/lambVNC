// scripts/vendor.js — runs via "postinstall" in package.json
// Downloads noVNC ESM source from GitHub into client/vendor/novnc/
// The npm package (@novnc/novnc) only ships Babel-compiled CJS (lib/) which
// does not work in the browser. The real ES module source is in core/ on GitHub.
const https = require('https');
const zlib = require('zlib');
const tar = require('tar');
const { pipeline } = require('stream/promises');
const fs = require('fs');
const path = require('path');

const NOVNC_VERSION = '1.5.0';
const NOVNC_URL = `https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz`;
const ARCHIVE_PREFIX = `noVNC-${NOVNC_VERSION}/`;
const DST = path.join(__dirname, '..', 'client', 'vendor', 'novnc');

function fetchWithRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const get = (u, remaining) => {
      https.get(u, { headers: { 'User-Agent': 'lambvnc-postinstall' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (remaining <= 0) return reject(new Error('Too many redirects'));
          get(res.headers.location, remaining - 1);
        } else if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${u}`));
        } else {
          resolve(res);
        }
      }).on('error', reject);
    };
    get(url, maxRedirects);
  });
}

async function main() {
  if (fs.existsSync(DST)) {
    fs.rmSync(DST, { recursive: true });
  }
  fs.mkdirSync(DST, { recursive: true });

  console.log(`Downloading noVNC v${NOVNC_VERSION} from GitHub...`);
  const response = await fetchWithRedirects(NOVNC_URL);

  // Extract core/ (ESM source) and vendor/ (pako etc.) from the tarball.
  // strip:1 removes the top-level "noVNC-1.5.0/" component so they land at DST/core/ and DST/vendor/
  await pipeline(
    response,
    zlib.createGunzip(),
    tar.extract({
      cwd: DST,
      strip: 1,
      filter: (entryPath) =>
        entryPath.startsWith(ARCHIVE_PREFIX + 'core/') ||
        entryPath.startsWith(ARCHIVE_PREFIX + 'vendor/'),
    })
  );

  console.log('noVNC vendored to client/vendor/novnc/');
}

main().catch((err) => {
  console.error('ERROR: failed to vendor noVNC:', err.message);
  process.exit(1);
});

