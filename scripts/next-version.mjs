// Works out the next release version for the Release workflow.
//
//   node scripts/next-version.mjs <bump> <release-type> [prerelease-identifier]
//
//   bump:          patch | minor | major
//   release-type:  prerelease | release
//
// Reads the current version from package.json and prints the next one.
//
// - `release` makes a stable version: `semver.inc(current, bump)`, the same as
//   `npm version <bump>`. On a release candidate that releases it
//   (1.3.0-rc.2 + minor → 1.3.0).
// - `prerelease` makes a release candidate of that same stable version. If the
//   current version is already a candidate of it, this is the next candidate
//   (1.3.0-rc.0 + minor → 1.3.0-rc.1); otherwise it is the first one
//   (1.2.3 + minor → 1.3.0-rc.0).
//
// test/next-version.test.ts covers every combination.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

/** @typedef {"patch" | "minor" | "major"} Bump */
/** @typedef {"prerelease" | "release"} ReleaseType */

/** @type {readonly Bump[]} */
export const BUMPS = ["patch", "minor", "major"];

/** @type {readonly ReleaseType[]} */
export const RELEASE_TYPES = ["prerelease", "release"];

export const DEFAULT_PRERELEASE_IDENTIFIER = "rc";

/**
 * @param {string} current The current version, e.g. "1.2.3".
 * @param {string} bump One of BUMPS.
 * @param {string} releaseType One of RELEASE_TYPES.
 * @param {string} [prereleaseIdentifier] Used for prereleases, e.g. "rc".
 * @returns {string} The next version, e.g. "1.3.0-rc.0".
 */
export function nextVersion(current, bump, releaseType, prereleaseIdentifier = DEFAULT_PRERELEASE_IDENTIFIER) {
  if (!semver.valid(current)) throw new Error(`Current version "${current}" is not a valid semver version.`);
  if (!(/** @type {readonly string[]} */ (BUMPS)).includes(bump)) {
    throw new Error(`Unknown version bump "${bump}". Use one of: ${BUMPS.join(", ")}.`);
  }
  if (!(/** @type {readonly string[]} */ (RELEASE_TYPES)).includes(releaseType)) {
    throw new Error(`Unknown release type "${releaseType}". Use one of: ${RELEASE_TYPES.join(", ")}.`);
  }
  const identifier = prereleaseIdentifier || DEFAULT_PRERELEASE_IDENTIFIER;
  if (!/^[0-9A-Za-z-]+$/.test(identifier)) {
    throw new Error(`Prerelease identifier "${identifier}" may only contain letters, digits and hyphens.`);
  }
  // SemVer also forbids leading zeros in a numeric identifier ("01").
  if (!semver.valid(`0.0.0-${identifier}`)) {
    throw new Error(`Prerelease identifier "${identifier}" is not valid in a semver version.`);
  }

  // The stable version this run releases, or makes a candidate of.
  const target = semver.inc(current, /** @type {Bump} */ (bump));
  if (!target) throw new Error(`Cannot apply "${bump}" to ${current}.`);
  if (releaseType === "release") return target;

  // Already a candidate of the same version: the next candidate (a new identifier
  // starts again at .0, e.g. 1.3.0-beta.3 → 1.3.0-rc.0).
  const parsed = semver.parse(current);
  const next =
    parsed && parsed.prerelease.length > 0 && `${parsed.major}.${parsed.minor}.${parsed.patch}` === target
      ? semver.inc(current, "prerelease", identifier)
      : `${target}-${identifier}.0`;
  if (!next || !semver.valid(next)) throw new Error(`Cannot make the next prerelease of ${current}.`);
  // A new identifier can sort before the current one (1.3.0-rc.2 → 1.3.0-beta.0):
  // never go backwards.
  if (!semver.gt(next, current)) {
    throw new Error(
      `The next prerelease ${next} is not newer than ${current}. Use a prerelease identifier that sorts after the current one, or a bigger version bump.`,
    );
  }
  return next;
}

// Run as a script (not when the tests import it).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [bump = "", releaseType = "", prereleaseIdentifier] = process.argv.slice(2);
  const packageJson = path.resolve(import.meta.dirname, "..", "package.json");
  const { version } = JSON.parse(readFileSync(packageJson, "utf8"));
  try {
    console.log(nextVersion(version, bump, releaseType, prereleaseIdentifier));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
