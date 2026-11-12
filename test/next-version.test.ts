import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { BUMPS, RELEASE_TYPES, nextVersion } from "../scripts/next-version.mjs";

const root = path.resolve(import.meta.dirname, "..");

describe("nextVersion", () => {
  // The same examples as .github/workflows/release.yml and RELEASE_GUIDE.md.
  test.each([
    ["1.2.3", "patch", "release", "1.2.4"],
    ["1.2.3", "minor", "release", "1.3.0"],
    ["1.2.3", "major", "release", "2.0.0"],
    ["1.2.3", "patch", "prerelease", "1.2.4-rc.0"],
    ["1.2.3", "minor", "prerelease", "1.3.0-rc.0"],
    ["1.2.3", "major", "prerelease", "2.0.0-rc.0"],
    ["1.3.0-rc.0", "minor", "prerelease", "1.3.0-rc.1"],
    ["1.3.0-rc.2", "minor", "release", "1.3.0"],
  ])("%s + %s %s → %s", (current, bump, releaseType, expected) => {
    expect(nextVersion(current, bump, releaseType)).toBe(expected);
  });

  test("each prerelease run of the same bump makes the next release candidate", () => {
    let version = "0.2.0";
    const seen = [];

    for (let index = 0; index < 4; index++) {
      seen.push((version = nextVersion(version, "minor", "prerelease")));
    }

    expect(seen).toEqual(["0.3.0-rc.0", "0.3.0-rc.1", "0.3.0-rc.2", "0.3.0-rc.3"]);
  });

  test("a release on a release candidate releases it", () => {
    expect(nextVersion("1.3.0-rc.2", "minor", "release")).toBe("1.3.0");
    expect(nextVersion("1.3.0-rc.2", "patch", "release")).toBe("1.3.0");
    expect(nextVersion("2.0.0-rc.2", "major", "release")).toBe("2.0.0");
  });

  test("a smaller bump on a release candidate continues it", () => {
    // Like `npm version patch` on 1.3.0-rc.2: the candidate is already ahead of a patch.
    expect(nextVersion("1.3.0-rc.2", "patch", "prerelease")).toBe("1.3.0-rc.3");
  });

  test("a bigger bump on a release candidate starts a new one", () => {
    expect(nextVersion("1.2.4-rc.1", "minor", "prerelease")).toBe("1.3.0-rc.0");
    expect(nextVersion("1.3.0-rc.2", "major", "prerelease")).toBe("2.0.0-rc.0");
  });

  test("uses the given prerelease identifier", () => {
    expect(nextVersion("1.2.3", "minor", "prerelease", "beta")).toBe("1.3.0-beta.0");
    expect(nextVersion("1.3.0-beta.3", "minor", "prerelease", "rc")).toBe("1.3.0-rc.0");
    expect(nextVersion("1.2.3", "minor", "prerelease", "")).toBe("1.3.0-rc.0");
    expect(nextVersion("1.2.3", "minor", "release", "beta")).toBe("1.3.0");
  });

  test("always moves forward", () => {
    for (const current of ["0.1.0", "1.2.3", "1.3.0-rc.2", "1.2.4-rc.0"]) {
      for (const bump of BUMPS) {
        for (const releaseType of RELEASE_TYPES) {
          expect(semver.gt(nextVersion(current, bump, releaseType), current)).toBe(true);
        }
      }
    }
  });

  test("rejects bad input", () => {
    expect(() => nextVersion("1.2.3", "huge", "release")).toThrow(/Unknown version bump/);
    expect(() => nextVersion("1.2.3", "preminor", "release")).toThrow(/Unknown version bump/);
    expect(() => nextVersion("1.2.3", "minor", "stable")).toThrow(/Unknown release type/);
    expect(() => nextVersion("not-a-version", "patch", "release")).toThrow(/not a valid semver/);
    expect(() => nextVersion("1.2.3", "minor", "prerelease", "rc 1")).toThrow(/letters, digits and hyphens/);
    expect(() => nextVersion("0.1.0", "minor", "prerelease", "01")).toThrow(/not valid in a semver version/);
  });

  test("never goes backwards with a different prerelease identifier", () => {
    expect(() => nextVersion("0.2.0-rc.2", "minor", "prerelease", "beta")).toThrow(/not newer than 0.2.0-rc.2/);
    expect(() => nextVersion("0.2.0-rc.foo", "minor", "prerelease", "rc")).toThrow(/not newer than/);
    // A bigger bump is fine: it starts a new version.
    expect(nextVersion("0.2.0-rc.2", "major", "prerelease", "beta")).toBe("1.0.0-beta.0");
  });
});

describe("next-version script", () => {
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ["scripts/next-version.mjs", ...args], { cwd: root, encoding: "utf8" }).trim();
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

  test("prints the next version for package.json", () => {
    expect(run("minor", "release")).toBe(nextVersion(version, "minor", "release"));
    expect(run("major", "prerelease", "beta")).toBe(nextVersion(version, "major", "prerelease", "beta"));
  });

  test("fails on an unknown bump or release type", () => {
    const fails = (...args: string[]) =>
      execFileSync(process.execPath, ["scripts/next-version.mjs", ...args], { cwd: root, stdio: "pipe" });

    expect(() => fails("huge", "release")).toThrow();
    expect(() => fails("minor")).toThrow();
  });
});
