// Build → npm pack → npm i -g of the tarball into a private prefix. The e2e tests run that
// installed copy, so they exercise exactly what a user gets from npm.
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

export interface E2EInfo {
  repoRoot: string;
  /** Scratch folder for the whole run (removed afterwards). */
  cacheRoot: string;
  /** The packed package (this checkout's version). */
  tarball: string;
  version: string;
  /** The same package repacked as a newer stable release, for `self update`. */
  nextTarball: string;
  nextVersion: string;
  /** The same package repacked as a newer prerelease (stable installs must never move to it). */
  rcTarball: string;
  rcVersion: string;
  /** npm prefix the package was installed into; `<prefix>/bin` holds `skill-library`. */
  prefix: string;
  binDir: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    e2e: E2EInfo;
  }
}

export const NEXT_VERSION = "99.0.0";
export const RC_VERSION = "99.1.0-rc.0";

// prepublishOnly runs tests inside `npm publish --dry-run`; inherited, npm_config_dry_run makes the
// child npm commands skip writing/installing.
function npmEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")));
  return { ...env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", ...extra };
}

function npm(args: string[], cwd: string, extra: Record<string, string> = {}): string {
  return execFileSync("npm", args, { cwd, encoding: "utf8", env: npmEnv(extra), stdio: ["ignore", "pipe", "pipe"] });
}

let cacheRoot: string | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  // Only ever inside the throwaway container that scripts/e2e.mjs starts: never on the host.
  if (process.env.SKILL_LIBRARY_E2E_CONTAINER !== "1") {
    throw new Error("The end-to-end tests only run in Docker, so they never touch this machine. Run: npm run test:e2e");
  }
  // E2E_SKIP_BUILD=1 reuses an existing dist/ (e.g. when several e2e runs share one checkout).
  if (process.env.E2E_SKIP_BUILD !== "1") execFileSync(process.execPath, [path.join(repoRoot, "scripts/build.mjs")], { stdio: "inherit", cwd: repoRoot });
  cacheRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "sl-e2e-")));
  const npmCache = path.join(cacheRoot, "npm-cache");

  const packed = JSON.parse(npm(["pack", "--pack-destination", cacheRoot, "--json", "--ignore-scripts"], repoRoot))[0];
  const tarball = path.join(cacheRoot, packed.filename);
  const version: string = packed.version;

  // Newer releases: same code, version bumped in package.json and in the bundle's --version.
  const repack = async (newVersion: string): Promise<string> => {
    const unpacked = path.join(cacheRoot!, `repack-${newVersion}`);
    await fsp.mkdir(unpacked);
    execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
    const pkgDir = path.join(unpacked, "package");
    const pkgJson = JSON.parse(await fsp.readFile(path.join(pkgDir, "package.json"), "utf8"));
    pkgJson.version = newVersion;
    await fsp.writeFile(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2));
    const bundle = path.join(pkgDir, "dist", "skill-library");
    await fsp.writeFile(bundle, (await fsp.readFile(bundle, "utf8")).split(JSON.stringify(version)).join(JSON.stringify(newVersion)));
    const repacked = JSON.parse(npm(["pack", "--pack-destination", cacheRoot!, "--json", "--ignore-scripts"], pkgDir))[0];
    return path.join(cacheRoot!, repacked.filename);
  };
  const nextTarball = await repack(NEXT_VERSION);
  const rcTarball = await repack(RC_VERSION);

  const prefix = path.join(cacheRoot, "prefix");
  npm(["install", "-g", "--offline", "--prefix", prefix, tarball], cacheRoot, { npm_config_cache: npmCache });
  const binDir = path.join(prefix, "bin");
  const out = execFileSync(path.join(binDir, "skill-library"), ["--version"], { encoding: "utf8" }).trim();
  if (out !== version) throw new Error(`installed skill-library prints ${out}, expected ${version}`);

  project.provide("e2e", { repoRoot, cacheRoot, tarball, version, nextTarball, nextVersion: NEXT_VERSION, rcTarball, rcVersion: RC_VERSION, prefix, binDir });
  return async () => {
    if (cacheRoot && !process.env.E2E_KEEP) await fsp.rm(cacheRoot, { recursive: true, force: true });
  };
}
