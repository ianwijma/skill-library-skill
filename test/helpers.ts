import { execFileSync, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BIN = path.resolve(import.meta.dirname, "..", "dist", "skill-library");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Env vars that make the CLI think it runs inside an agent; cleared unless a test sets them. */
const AGENT_ENV = [
  "AI_AGENT", "CURSOR_TRACE_ID", "CURSOR_AGENT", "CURSOR_EXTENSION_HOST_ROLE", "GEMINI_CLI", "CODEX_SANDBOX", "CODEX_CI",
  "CODEX_THREAD_ID", "ANTIGRAVITY_AGENT", "AUGMENT_AGENT", "OPENCODE_CLIENT", "CLAUDECODE", "CLAUDE_CODE", "CLAUDE_CODE_IS_COWORK",
  "REPL_ID", "COPILOT_MODEL", "COPILOT_ALLOW_ALL", "COPILOT_GITHUB_TOKEN", "CLAUDE_CODE_ENTRYPOINT",
];
const CI_ENV = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TRAVIS", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION"];

export interface Sandbox {
  root: string;
  home: string;
  store: string;
  env: Record<string, string>;
}

/** A temp HOME with everything the CLI reads pointed inside it. */
export async function sandbox(): Promise<Sandbox> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "sl-test-")));
  const home = path.join(root, "home");
  await fsp.mkdir(home, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of [...AGENT_ENV, ...CI_ENV, "TYPESAFE_API_KEY", "TYPESAFE_API_BASE", "GITHUB_TOKEN", "GH_TOKEN"]) delete env[k];
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    SKILL_LIBRARY_DIR: path.join(home, "library"),
    SKILL_LIBRARY_NO_GATEWAY: "1",
    SLI_RETRY_BASE_MS: "10",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    NO_COLOR: "1",
  });
  return { root, home, store: env.SKILL_LIBRARY_DIR!, env };
}

export function run(sb: Sandbox, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string } = {}): Promise<RunResult> {
  const env = { ...sb.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? sb.root,
      env,
      stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    proc.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.stdin !== undefined) proc.stdin!.end(opts.stdin);
  });
}

export function skillMd(name: string, description: string, body = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${body}`;
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
  }
}

export function git(sb: Sandbox, cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: sb.env, encoding: "utf8" }).trim();
}

/** A bare repo (file:// URL) with `files` committed; returns url and the work tree to commit more. */
export async function gitRepo(sb: Sandbox, name: string, files: Record<string, string>, opts: { allowSha?: boolean } = {}) {
  const work = path.join(sb.root, "repos", `${name}-work`);
  const bare = path.join(sb.root, "repos", `${name}.git`);
  await fsp.mkdir(work, { recursive: true });
  git(sb, work, ["init", "-q", "-b", "main"]);
  await writeFiles(work, files);
  git(sb, work, ["add", "-A"]);
  git(sb, work, ["commit", "-q", "-m", "init"]);
  git(sb, sb.root, ["clone", "-q", "--bare", work, bare]);
  if (opts.allowSha !== false) git(sb, bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  git(sb, bare, ["config", "uploadpack.allowFilter", "true"]);
  git(sb, work, ["remote", "add", "origin", bare]);
  const url = `file://${bare}`;
  const commit = async (more: Record<string, string>, remove: string[] = []): Promise<string> => {
    await writeFiles(work, more);
    for (const r of remove) await fsp.rm(path.join(work, r), { recursive: true, force: true });
    git(sb, work, ["add", "-A"]);
    git(sb, work, ["commit", "-q", "-m", "change"]);
    git(sb, work, ["push", "-q", "origin", "main"]);
    return git(sb, work, ["rev-parse", "HEAD"]);
  };
  return { url, bare, work, head: git(sb, work, ["rev-parse", "HEAD"]), commit };
}

export async function readJson(file: string): Promise<any> {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

export async function project(sb: Sandbox, name = "proj"): Promise<string> {
  const dir = path.join(sb.root, name);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}
