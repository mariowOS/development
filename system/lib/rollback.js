// mariowOS builder note: rollback point for system updates, shared by the kernel
// (server.js creates it before applying an update) and the launcher (which restores
// it when the updated kernel keeps crashing). Plain fs only: it must work while the
// kernel is down.
//
// Layout of <root>/.rollback/:
//   manifest.json  { fromVersion, toVersion, createdAt, verified, rolledBack, replaced[], created[] }
//   files/<path>   the previous contents of every file the update replaced
// Only one rollback point is kept: the one for the most recent system update.

const fs = require("fs");
const path = require("path");

const ROLLBACK_DIRNAME = ".rollback";

function rollbackPaths(root) {
  const dir = path.join(root, ROLLBACK_DIRNAME);
  return { dir, files: path.join(dir, "files"), manifest: path.join(dir, "manifest.json") };
}

const toNative = (root, relativePath) => path.join(root, ...relativePath.split("/"));

function readVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "version.json"), "utf8")).version || null; }
  catch (e) { return null; }
}

// Snapshot what `files` ({ relativePath, blobHash }) would overwrite. Files whose current
// contents already match the update (`isUnchanged`) are skipped, so a release that ships
// thousands of unchanged files (node_modules) does not copy them all.
function createRollbackPoint(root, files, { toVersion = null, isProtected = () => false, isUnchanged = () => false } = {}) {
  const paths = rollbackPaths(root);
  fs.rmSync(paths.dir, { recursive: true, force: true });
  fs.mkdirSync(paths.files, { recursive: true });
  const replaced = [];
  const created = [];
  for (const file of files) {
    if (isProtected(file.relativePath)) continue;
    const target = toNative(root, file.relativePath);
    if (!fs.existsSync(target)) { created.push(file.relativePath); continue; }
    const contents = fs.readFileSync(target);
    if (isUnchanged(contents, file)) continue;
    const backup = toNative(paths.files, file.relativePath);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, contents);
    replaced.push(file.relativePath);
  }
  const manifest = {
    fromVersion: readVersion(root), toVersion, createdAt: new Date().toISOString(),
    verified: false, rolledBack: false, replaced, created
  };
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2));
  return manifest;
}

function readRollbackPoint(root) {
  try { return JSON.parse(fs.readFileSync(rollbackPaths(root).manifest, "utf8")); }
  catch (e) { return null; }
}

function writeManifest(root, manifest) {
  fs.writeFileSync(rollbackPaths(root).manifest, JSON.stringify(manifest, null, 2));
}

// Restorable = there is a snapshot that has not been used yet.
function canRollback(root) {
  const manifest = readRollbackPoint(root);
  return Boolean(manifest && !manifest.rolledBack);
}

// The updated kernel booted fine: an unrelated crash later must not undo the update.
function markRollbackVerified(root) {
  const manifest = readRollbackPoint(root);
  if (!manifest || manifest.verified || manifest.rolledBack) return;
  manifest.verified = true;
  writeManifest(root, manifest);
}

function removeEmptyParents(root, filePath) {
  let dir = path.dirname(filePath);
  while (dir.startsWith(root + path.sep) && dir !== root) {
    try { fs.rmdirSync(dir); } catch (e) { return; } // not empty (or gone): stop
    dir = path.dirname(dir);
  }
}

// Put back the files the last update replaced and delete the ones it added.
function restoreRollbackPoint(root) {
  const paths = rollbackPaths(root);
  const manifest = readRollbackPoint(root);
  if (!manifest || manifest.rolledBack) throw new Error("No update to roll back.");
  for (const relativePath of manifest.replaced) {
    const backup = toNative(paths.files, relativePath);
    const target = toNative(root, relativePath);
    const temporary = `${target}.rollback-${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backup, temporary);
    fs.renameSync(temporary, target);
  }
  for (const relativePath of manifest.created) {
    const target = toNative(root, relativePath);
    fs.rmSync(target, { force: true });
    removeEmptyParents(root, target);
  }
  fs.rmSync(paths.files, { recursive: true, force: true });
  manifest.rolledBack = true;
  manifest.rolledBackAt = new Date().toISOString();
  writeManifest(root, manifest);
  return manifest;
}

module.exports = {
  ROLLBACK_DIRNAME,
  createRollbackPoint,
  readRollbackPoint,
  canRollback,
  markRollbackVerified,
  restoreRollbackPoint
};
