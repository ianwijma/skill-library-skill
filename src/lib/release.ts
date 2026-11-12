// skill-library's own releases: what npm has, and the copy npm installed globally.
import { execFile, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import semver from "semver";
import { msgOf } from "./cli.ts";

export const PACKAGE_NAME = "skill-library";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 5_000;

export interface ReleaseCheck {
  current: string;
  /** Newest release this install should move to, or null when it is already the newest (or the check failed). */
  latest: string | null;
  updateAvailable: boolean;
  /** The command that installs `latest` (`skill-library self update`). */
  command: string | null;
  /** Why the registry couldn't be asked. */
  error?: string;
}

/**
 * Pick the release to offer: `latest`, or for a prerelease install also `next`, whichever is
 * newer. Returns null when nothing beats `current`.
 *
 * A stable install never moves to a prerelease, whatever the dist-tags point at (a release
 * candidate mistakenly published under `latest` included). Only a prerelease install can.
 */
export function newerRelease(current: string, tags: Record<string, unknown>): string | null {
  if (!semver.valid(current)) return null;
  const onPrerelease = semver.prerelease(current) !== null;
  const candidates = [tags.latest];
  if (onPrerelease) candidates.push(tags.next);
  let best: string | null = null;
  for (const c of candidates) {
    if (typeof c !== "string" || !semver.valid(c)) continue;
    if (!onPrerelease && semver.prerelease(c)) continue;
    if (semver.gt(c, current) && (best === null || semver.gt(c, best))) best = c;
  }
  return best;
}

/** The package's dist-tags (`latest`, `next`, …) from the npm registry. Throws with a readable message. */
export async function fetchDistTags(): Promise<Record<string, unknown>> {
  const registry = (process.env.SKILL_LIBRARY_NPM_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${registry}/-/package/${PACKAGE_NAME}/dist-tags`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`couldn't reach the npm registry: ${msgOf(err)}`);
  }
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const tags = (await res.json().catch(() => null)) as unknown;
  if (typeof tags !== "object" || tags === null) throw new Error("npm registry returned an unexpected response");
  return tags as Record<string, unknown>;
}

export async function checkRelease(current: string): Promise<ReleaseCheck> {
  const base: ReleaseCheck = { current, latest: null, updateAvailable: false, command: null };
  if (!semver.valid(current)) return { ...base, error: `version ${current} is not a release version` };
  try {
    const latest = newerRelease(current, await fetchDistTags());
    if (latest === null) return base;
    return { ...base, latest, updateAvailable: true, command: `${PACKAGE_NAME} self update` };
  } catch (err) {
    return { ...base, error: msgOf(err) };
  }
}

// --- npm --------------------------------------------------------------------------------------

/** npm, pnpm and yarn are .cmd shims on Windows, which only start through a shell. */
const SHELL = process.platform === "win32";

function npmOutput(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("npm", args, { timeout: 30_000, shell: SHELL }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

export async function npmVersion(): Promise<string | null> {
  return npmOutput(["--version"]);
}

/** npm's global node_modules folder (`npm root -g`), or null when npm isn't available. */
export async function npmGlobalRoot(): Promise<string | null> {
  return npmOutput(["root", "-g"]);
}

export interface GlobalInstall {
  version: string;
  /** The CLI script inside the installed package (run it with node). */
  script: string;
}

/** The copy of skill-library installed with `npm i -g`, or null when there is none. */
export async function globalInstall(root?: string | null): Promise<GlobalInstall | null> {
  const dir = root === undefined ? await npmGlobalRoot() : root;
  if (!dir) return null;
  const pkg = path.join(dir, PACKAGE_NAME);
  try {
    const { version } = JSON.parse(await fsp.readFile(path.join(pkg, "package.json"), "utf8")) as { version?: unknown };
    const script = path.join(pkg, "dist", PACKAGE_NAME);
    await fsp.access(script);
    return typeof version === "string" ? { version, script } : null;
  } catch {
    return null;
  }
}

/** Can npm write into its global folder (or create it)? */
export async function globalRootWritable(root: string): Promise<boolean> {
  let dir = root;
  for (;;) {
    try {
      await fsp.access(dir, fsp.constants.W_OK);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

/** `npm i -g skill-library@<version>`, output shown to the user. Resolves to npm's exit code. */
export function npmInstallGlobal(version: string): Promise<number> {
  return run("npm", ["i", "-g", `${PACKAGE_NAME}@${version}`], SHELL);
}

/** Run a command with inherited stdio; resolves to its exit code (127 when it can't start). */
export function run(cmd: string, args: string[], shell = false, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "inherit", shell, env });
    proc.on("error", () => resolve(127));
    proc.on("close", (code) => resolve(code ?? 1));
  });
}


