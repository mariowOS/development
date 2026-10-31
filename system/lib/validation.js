// mariowOS builder note: pure version & URL-validation helpers, split out of server.js
// so they can be unit-tested without booting the kernel.

// Semantic version comparison. The updater must only ever offer a NEWER build:
// comparing versions as plain strings made 1.0.0 look like an "update" for 1.1.0,
// which offered the user a silent downgrade.
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version) {
  const match = SEMVER_PATTERN.exec(String(version || "").trim());
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : []
  };
}

function comparePrerelease(left, right) {
  // A build with no prerelease tag outranks the same release with one (1.2.0 > 1.2.0-beta).
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (Number(leftPart) !== Number(rightPart)) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

// Returns -1, 0 or 1, or null when either side is not a version we understand.
function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return null;

  for (let index = 0; index < 3; index++) {
    if (parsedLeft.release[index] !== parsedRight.release[index]) {
      return parsedLeft.release[index] < parsedRight.release[index] ? -1 : 1;
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

// The only question the updater should ever ask: is `candidate` strictly newer than
// `installed`? Unparseable versions fall back to "different means newer" so a custom
// build string still gets offered, but equal strings never do.
function isNewerVersion(candidate, installed) {
  const order = compareVersions(candidate, installed);
  return order === null ? String(candidate) !== String(installed) : order > 0;
}

function getRawGithubUrl(repoUrl) {
  // Store apps live on GitHub, and this helper turns a repo URL into a default icon URL.
  // It helps the app catalog show something meaningful even before a custom icon is uploaded.
  if (!repoUrl) return null;
  const cleanUrl = repoUrl.replace(/\.git$/, '');
  const match = cleanUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? `https://raw.githubusercontent.com/${match[1]}/main/icon.png` : null;
}

// SECURITY (A-07 adjacent): store apps are installed from, and updated against, their
// source repository. Accept ONLY https github.com repo URLs so that:
//  - `git clone`/`git pull` can't be pointed at a local path, a non-https transport,
//    or an "ext::"/option-injection URL, and
//  - update checks fetch version metadata only from the repo the app came from.
function isAllowedRepoUrl(repoUrl) {
  if (typeof repoUrl !== "string") return false;
  try {
    const u = new URL(repoUrl);
    return u.protocol === "https:" &&
      (u.hostname === "github.com" || u.hostname === "raw.githubusercontent.com") &&
      /^\/[^/]+\/[^/]+/.test(u.pathname);
  } catch (e) { return false; }
}

// Raw URLs for a file in the repo, trying main then master.
function getRepoRawUrls(repoUrl, file) {
  if (!repoUrl) return [];
  const cleanUrl = repoUrl.replace(/\.git$/, "");
  const match = cleanUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) return [];
  return ["main", "master"].map(b => `https://raw.githubusercontent.com/${match[1]}/${b}/${file}`);
}


module.exports = {
  SEMVER_PATTERN,
  parseVersion,
  comparePrerelease,
  compareVersions,
  isNewerVersion,
  getRawGithubUrl,
  isAllowedRepoUrl,
  getRepoRawUrls
};
