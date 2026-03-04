// scripts/vendor.js — runs via "postinstall" in package.json
// Copies noVNC core/ and vendor/ into client/vendor/novnc/
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', '@novnc', 'novnc');
const dst = path.join(__dirname, '..', 'client', 'vendor', 'novnc');

// ARCHITECTURE.md §20: copy core/ and vendor/ from the npm package
const coreSrc = path.join(src, 'core');
const vendorSrc = path.join(src, 'vendor');
const coreDst = path.join(dst, 'core');
const vendorDst = path.join(dst, 'vendor');

// Ensure destination exists
if (!fs.existsSync(dst)) {
  fs.mkdirSync(dst, { recursive: true });
}

// Copy core/
if (fs.existsSync(coreSrc)) {
  fs.cpSync(coreSrc, coreDst, { recursive: true });
} else {
  // Fallback: some noVNC versions use lib/ instead of core/
  const libSrc = path.join(src, 'lib');
  if (fs.existsSync(libSrc)) {
    fs.cpSync(libSrc, coreDst, { recursive: true });
  } else {
    console.error('ERROR: Could not find noVNC core/ or lib/ directory in', src);
    process.exit(1);
  }
}

// Copy vendor/ if it exists
if (fs.existsSync(vendorSrc)) {
  fs.cpSync(vendorSrc, vendorDst, { recursive: true });
}

console.log('noVNC vendored to client/vendor/novnc/');
