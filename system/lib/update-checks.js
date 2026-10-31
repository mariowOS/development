// mariowOS builder note: checks a downloaded system update must pass before it is
// applied. Shared by the kernel updater (server.js) and the release script
// (tools/release.js), so a release is refused at publish time for the same reasons a
// device would refuse it.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BUILTIN_MODULES = new Set(require("module").builtinModules);

// Git blob hash ("blob <size>\0<bytes>", SHA-1): what `git ls-files -s` reports for a file.
function gitBlobHash(buffer) {
  return crypto.createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

// True when `contents` is the blob `expectedHash`. A Windows checkout may have turned
// LF into CRLF (core.autocrlf), so text files are also compared with CRLF normalised.
function matchesGitBlob(contents, expectedHash) {
  if (gitBlobHash(contents) === expectedHash) return true;
  const text = contents.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(contents) || !text.includes("\r\n")) return false;
  return gitBlobHash(Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")) === expectedHash;
}

// `node --check` only proves the staged server parses. A release that requires a file or
// package it forgot to ship still passes it and then crash-loops every machine on boot.
// Walk the kernel's require graph from server.js (and launcher.js) and fail if anything
// the new code needs is neither in the release nor already installed in `installRoot`.
function validateStagedRuntime(stagePath, files, installRoot) {
  const staged = new Set(files.map(file => file.relativePath));
  const existsInRelease = relativePath => staged.has(relativePath) ||
    Boolean(installRoot && fs.existsSync(path.join(installRoot, ...relativePath.split("/"))));
  const readSource = relativePath => {
    const stagedFile = path.join(stagePath, ...relativePath.split("/"));
    return fs.readFileSync(fs.existsSync(stagedFile) ? stagedFile : path.join(installRoot, ...relativePath.split("/")), "utf8");
  };
  const resolveLocal = (fromFile, request) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), request));
    return [base, `${base}.js`, `${base}.json`, `${base}/index.js`].find(existsInRelease) || null;
  };
  const hasPackage = name => existsInRelease(`node_modules/${name}/package.json`);

  const problems = [];
  const visited = new Set();
  const queue = ["server.js", "launcher.js"].filter(existsInRelease);
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readSource(file);
    for (const match of source.matchAll(/require\(\s*(["'])([^"']+)\1\s*\)/g)) {
      const request = match[2];
      if (request.startsWith(".")) {
        const resolved = resolveLocal(file, request);
        if (!resolved) problems.push(`${file} requires missing file ${request}`);
        else if (resolved.endsWith(".js")) queue.push(resolved);
        continue;
      }
      if (request.startsWith("node:") || BUILTIN_MODULES.has(request) || request === "electron") continue;
      const name = request.startsWith("@") ? request.split("/").slice(0, 2).join("/") : request.split("/")[0];
      if (!hasPackage(name)) problems.push(`${file} requires missing package ${name}`);
    }
  }
  if (problems.length) {
    throw new Error(`The update is incomplete and would not boot: ${[...new Set(problems)].join("; ")}`);
  }
}

// --- SIGNED RELEASES (A-07) ---
// tools/release.js writes release-manifest.json (the version plus the git blob hash of
// every file in the release) and signs it with the maintainer's Ed25519 key. Devices
// that have update-pubkey.pem accept an update only if that signature is valid AND every
// downloaded file matches the manifest, so nobody without the private key can publish a
// release, even with write access to the GitHub repository.
const RELEASE_MANIFEST = "release-manifest.json";
const RELEASE_SIGNATURE = "release-manifest.json.sig";
// Device-local files the updater never applies: they may differ from the manifest.
const UNSIGNED_LOCAL_FILES = new Set(["config.json", "sota-installed.json"]);

// The signature covers the manifest with LF line endings, so it survives a CRLF checkout.
const manifestSigningBytes = text => Buffer.from(String(text).replace(/\r\n/g, "\n"), "utf8");

function buildReleaseManifest(version, entries) {
  const files = {};
  for (const entry of [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    if (entry.relativePath === RELEASE_MANIFEST || entry.relativePath === RELEASE_SIGNATURE) continue;
    files[entry.relativePath] = entry.blobHash;
  }
  return JSON.stringify({ format: 1, version, files }, null, 2) + "\n";
}

function signReleaseManifest(manifestText, privateKeyPem) {
  return crypto.sign(null, manifestSigningBytes(manifestText), privateKeyPem).toString("base64");
}

// `files`: the staged entries ({ relativePath, blobHash }) as git reports them.
function verifyReleaseSignature(stagePath, files, publicKeyPem) {
  let manifestText;
  let signature;
  try {
    manifestText = fs.readFileSync(path.join(stagePath, RELEASE_MANIFEST), "utf8");
    signature = Buffer.from(fs.readFileSync(path.join(stagePath, RELEASE_SIGNATURE), "utf8").trim(), "base64");
  } catch (e) {
    return { ok: false, reason: "this release is not signed" };
  }
  let valid = false;
  try { valid = crypto.verify(null, manifestSigningBytes(manifestText), publicKeyPem, signature); }
  catch (e) { return { ok: false, reason: "signature check error: " + e.message }; }
  if (!valid) return { ok: false, reason: "invalid release signature" };

  let manifest;
  try { manifest = JSON.parse(manifestText); } catch (e) { return { ok: false, reason: "release manifest is not valid JSON" }; }
  const signed = manifest && manifest.files && typeof manifest.files === "object" ? manifest.files : {};
  let stagedVersion = null;
  try { stagedVersion = JSON.parse(fs.readFileSync(path.join(stagePath, "version.json"), "utf8")).version; } catch (e) {}
  if (manifest.version !== stagedVersion) return { ok: false, reason: "version.json does not match the signed release" };

  const seen = new Set();
  for (const file of files) {
    if (file.relativePath === RELEASE_MANIFEST || file.relativePath === RELEASE_SIGNATURE) continue;
    if (UNSIGNED_LOCAL_FILES.has(file.relativePath)) continue;
    if (signed[file.relativePath] !== file.blobHash) {
      return { ok: false, reason: `${file.relativePath} is not part of the signed release` };
    }
    seen.add(file.relativePath);
  }
  const missing = Object.keys(signed).find(name => !seen.has(name) && !UNSIGNED_LOCAL_FILES.has(name));
  if (missing) return { ok: false, reason: `${missing} is missing from the download` };
  return { ok: true, version: manifest.version };
}

module.exports = {
  gitBlobHash,
  matchesGitBlob,
  validateStagedRuntime,
  RELEASE_MANIFEST,
  RELEASE_SIGNATURE,
  buildReleaseManifest,
  signReleaseManifest,
  verifyReleaseSignature
};
