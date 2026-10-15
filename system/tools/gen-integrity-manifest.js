#!/usr/bin/env node
// Generates system/integrity-manifest.json for verified-boot / tamper detection.
// Run from the repo at release time, from the `system` folder's parent or anywhere:
//   node system/tools/gen-integrity-manifest.js
// Then sign it so a tamperer can't rewrite it to match their changes:
//   openssl pkeyutl -sign -inkey update-priv.pem -rawin \
//     -in system/integrity-manifest.json | base64 > system/integrity-manifest.json.sig
// Commit the manifest and its .sig (and system/update-pubkey.pem). Never commit the key.
//
// The manifest records the sha256 of every "stock" file under system/, skipping files
// that legitimately change per machine (config, logs, user assets, caches).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const systemDir = path.resolve(__dirname, "..");

// Paths (relative to systemDir) that are NOT part of stock and must be skipped.
const SKIP_DIRS = new Set(["node_modules", "tools", "sandbox"]);
const SKIP_FILES = new Set([
  "config.json", "keys.json", "session.key", "spotify-token.json",
  "integrity-manifest.json", "integrity-manifest.json.sig",
  "mariowos.log", "mail-error.log", ".env", "boot-mode.json",
  "sota-installed.json"
]);
const SKIP_PATTERNS = [/\.log$/i, /\.user\.png$/i, /^desktop\/assets\/icon_.+\.png$/i,
  /^desktop\/apps\/sandbox\//i, /\.git/i];

function shouldSkip(rel) {
  const first = rel.split("/")[0];
  if (SKIP_DIRS.has(first)) return true;
  if (SKIP_FILES.has(rel) || SKIP_FILES.has(path.basename(rel))) return true;
  return SKIP_PATTERNS.some(re => re.test(rel));
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(systemDir, abs).split(path.sep).join("/");
    if (shouldSkip(rel)) continue;
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile()) {
      out[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
  }
}

const files = {};
walk(systemDir, files);
const manifest = { generatedAt: new Date().toISOString(), files };
const outPath = path.join(systemDir, "integrity-manifest.json");
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`Wrote ${outPath} with ${Object.keys(files).length} files.`);
console.log("Now sign it (see header of this script) and commit the .json + .sig.");
