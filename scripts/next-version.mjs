// Works out the next release version for the Release workflow.
//
//   node scripts/next-version.mjs <bump> [prerelease-identifier]
//
// Reads the current version from package.json and prints the next one. It uses
// `semver.inc`, the same function `npm version <bump>` uses, so the result matches
// what npm would pick. test/next-version.test.ts covers every bump.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

/** @typedef {"patch" | "minor" | "major" | "prepatch" | "preminor" | "premajor" | "prerelease"} Bump */

/** @type {readonly Bump[]} */
export const BUMPS = ["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"];

export const DEFAULT_PRERELEASE_IDENTIFIER = "rc";

/**
 * @param {string} current The current version, e.g. "1.2.3".
 * @param {string} bump One of BUMPS.
 * @param {string} [prereleaseIdentifier] Used by the pre* bumps, e.g. "rc".
 * @returns {string} The next version, e.g. "1.2.4".
 */
export function nextVersion(current, bump, prereleaseIdentifier = DEFAULT_PRERELEASE_IDENTIFIER) {
  if (!semver.valid(current)) throw new Error(`Current version "${current}" is not a valid semver version.`);
  if (!(/** @type {readonly string[]} */ (BUMPS)).includes(bump)) {
    throw new Error(`Unknown bump "${bump}". Use one of: ${BUMPS.join(", ")}.`);
  }
  const identifier = prereleaseIdentifier || DEFAULT_PRERELEASE_IDENTIFIER;
  if (!/^[0-9A-Za-z-]+$/.test(identifier)) {
    throw new Error(`Prerelease identifier "${identifier}" may only contain letters, digits and hyphens.`);
  }
  const next = semver.inc(current, /** @type {Bump} */ (bump), identifier);
  if (!next) throw new Error(`Cannot apply "${bump}" to ${current}.`);
  return next;
}

// Run as a script (not when the tests import it).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [bump = "", prereleaseIdentifier] = process.argv.slice(2);
  const packageJson = path.resolve(import.meta.dirname, "..", "package.json");
  const { version } = JSON.parse(readFileSync(packageJson, "utf8"));
  try {
    console.log(nextVersion(version, bump, prereleaseIdentifier));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
