import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./cli.ts";
import { isCommitSha } from "./source.ts";

const TIMEOUT_MS = Number(process.env.SKILLS_CLONE_TIMEOUT_MS) > 0 ? Number(process.env.SKILLS_CLONE_TIMEOUT_MS) : 120_000;

function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined;
}

function isGitHubHttps(url: string): boolean {
  return /^https:\/\/github\.com\//i.test(url);
}

/** Env for git: no prompts, no CRLF conversion, token only for github.com via GIT_CONFIG_* (never argv). */
function gitEnv(url: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", LC_ALL: "C" };
  const configs: Array<[string, string]> = [["core.autocrlf", "false"]];
  const token = githubToken();
  if (token && url && isGitHubHttps(url)) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    configs.push(["http.https://github.com/.extraheader", `Authorization: basic ${basic}`]);
  }
  const base = Number(env.GIT_CONFIG_COUNT) || 0;
  configs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${base + i}`] = k;
    env[`GIT_CONFIG_VALUE_${base + i}`] = v;
  });
  env.GIT_CONFIG_COUNT = String(base + configs.length);
  return env;
}

function redact(text: string): string {
  const token = githubToken();
  let out = text;
  if (token) out = out.split(token).join("***");
  return out.replace(/Authorization: basic [A-Za-z0-9+/=]+/g, "Authorization: ***");
}

export async function git(args: string[], opts: { cwd?: string; url?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: opts.cwd, env: gitEnv(opts.url), timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") {
            reject(new CliError(2, "git is not installed or not on PATH (needed for remote sources)"));
            return;
          }
          const detail = redact(String(stderr || err.message).trim().split("\n").slice(-3).join(" "));
          reject(new CliError(2, e.killed ? `git timed out: ${detail}` : detail));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

export async function tempDir(prefix = "skill-library-"): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanup(dir: string | null | undefined): Promise<void> {
  if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Shallow clone at `ref` (branch, tag or full SHA). Returns the checkout and its commit. */
export async function cloneRepo(url: string, ref?: string): Promise<{ dir: string; commit: string }> {
  const dir = await tempDir();
  try {
    if (ref && isCommitSha(ref)) {
      await checkoutCommitInto(dir, url, ref);
    } else {
      const args = ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", url, dir];
      try {
        await git(args, { url });
      } catch (err) {
        throw new CliError(2, `Failed to clone ${url}: ${(err as Error).message}`);
      }
    }
    const commit = await git(["rev-parse", "HEAD"], { cwd: dir });
    return { dir, commit };
  } catch (err) {
    await cleanup(dir);
    throw err;
  }
}

/** Fetch exactly `sha` into an empty `dir` (depth 1; falls back to a full clone). */
async function checkoutCommitInto(dir: string, url: string, sha: string): Promise<void> {
  try {
    await git(["init", "-q", dir], {});
    await git(["remote", "add", "origin", url], { cwd: dir });
    await git(["fetch", "-q", "--depth", "1", "origin", sha], { cwd: dir, url });
    await git(["checkout", "-q", "FETCH_HEAD"], { cwd: dir });
    return;
  } catch {
    // Servers that refuse fetch-by-commit (uploadpack.allowAnySHA1InWant off): full clone.
  }
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  try {
    await git(["clone", "-q", "--no-checkout", "--", url, dir], { url });
    await git(["checkout", "-q", sha], { cwd: dir });
  } catch (err) {
    throw new CliError(2, `Failed to fetch ${sha.slice(0, 12)} from ${url}: ${(err as Error).message}`);
  }
}

/** Shallow checkout of one commit. */
export async function fetchCommit(url: string, sha: string): Promise<string> {
  const dir = await tempDir();
  try {
    await checkoutCommitInto(dir, url, sha);
    return dir;
  } catch (err) {
    await cleanup(dir);
    throw err;
  }
}

/** Tree id of `sub` ("" = root) at HEAD of a checkout, or null when the path is absent. */
export async function treeAt(dir: string, sub: string): Promise<string | null> {
  try {
    return await git(["rev-parse", sub === "" ? "HEAD^{tree}" : `HEAD:${sub}`], { cwd: dir });
  } catch {
    return null;
  }
}

/** Head commit of `ref` on the remote and the tree id of `sub` there (blob-less shallow fetch). */
export async function remoteTree(url: string, ref: string | null, sub: string): Promise<{ commit: string; tree: string | null }> {
  const dir = await tempDir();
  try {
    await git(["init", "-q", dir], {});
    await git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "--", url, ref ?? "HEAD"], { cwd: dir, url });
    const commit = await git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
    let tree: string | null = null;
    try {
      tree = await git(["rev-parse", sub === "" ? "FETCH_HEAD^{tree}" : `FETCH_HEAD:${sub}`], { cwd: dir });
    } catch {
      tree = null;
    }
    return { commit, tree };
  } finally {
    await cleanup(dir);
  }
}
