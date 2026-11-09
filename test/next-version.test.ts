import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { BUMPS, nextVersion } from "../scripts/next-version.mjs";

const root = path.resolve(import.meta.dirname, "..");

describe("nextVersion", () => {
  // The same examples as the bump options in .github/workflows/release.yml and the README.
  test.each([
    ["1.2.3", "patch", "1.2.4"],
    ["1.2.3", "minor", "1.3.0"],
    ["1.2.3", "major", "2.0.0"],
    ["1.2.3", "prepatch", "1.2.4-rc.0"],
    ["1.2.3", "preminor", "1.3.0-rc.0"],
    ["1.2.3", "premajor", "2.0.0-rc.0"],
    ["1.2.3", "prerelease", "1.2.4-rc.0"],
    ["1.3.0-rc.0", "prerelease", "1.3.0-rc.1"],
  ])("%s + %s → %s", (current, bump, expected) => {
    expect(nextVersion(current, bump)).toBe(expected);
  });

  test("each prerelease run makes the next release candidate", () => {
    let version = nextVersion("1.2.3", "preminor");
    const seen = [version];
    for (let i = 0; i < 3; i++) seen.push((version = nextVersion(version, "prerelease")));
    expect(seen).toEqual(["1.3.0-rc.0", "1.3.0-rc.1", "1.3.0-rc.2", "1.3.0-rc.3"]);
  });

  test("a stable bump on a release candidate releases it", () => {
    expect(nextVersion("1.3.0-rc.2", "minor")).toBe("1.3.0");
    expect(nextVersion("1.3.0-rc.2", "patch")).toBe("1.3.0");
    expect(nextVersion("2.0.0-rc.2", "major")).toBe("2.0.0");
  });

  test("a pre* bump on a release candidate starts a new line instead of continuing it", () => {
    expect(nextVersion("1.3.0-rc.2", "preminor")).toBe("1.4.0-rc.0");
  });

  test("uses the given prerelease identifier", () => {
    expect(nextVersion("1.2.3", "preminor", "beta")).toBe("1.3.0-beta.0");
    expect(nextVersion("1.3.0-rc.2", "prerelease", "beta")).toBe("1.3.0-beta.0");
    expect(nextVersion("1.2.3", "preminor", "")).toBe("1.3.0-rc.0");
  });

  test("always moves forward", () => {
    for (const current of ["0.1.0", "1.2.3", "1.3.0-rc.2"]) {
      for (const bump of BUMPS) expect(semver.gt(nextVersion(current, bump), current)).toBe(true);
    }
  });

  test("rejects bad input", () => {
    expect(() => nextVersion("1.2.3", "huge")).toThrow(/Unknown bump/);
    expect(() => nextVersion("not-a-version", "patch")).toThrow(/not a valid semver/);
    expect(() => nextVersion("1.2.3", "preminor", "rc 1")).toThrow(/letters, digits and hyphens/);
  });
});

describe("next-version script", () => {
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ["scripts/next-version.mjs", ...args], { cwd: root, encoding: "utf8" }).trim();
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

  test("prints the next version for package.json", () => {
    expect(run("minor")).toBe(semver.inc(version, "minor"));
    expect(run("preminor", "beta")).toBe(semver.inc(version, "preminor", "beta"));
  });

  test("fails on an unknown bump", () => {
    expect(() => execFileSync(process.execPath, ["scripts/next-version.mjs", "huge"], { cwd: root, stdio: "pipe" })).toThrow();
  });
});
