import { execFileSync, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

export const BIN = path.resolve(import.meta.dirname, "..", "dist", "skill-library");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Env vars that make the CLI think it runs inside an agent; cleared unless a test sets them. */
export const AGENT_ENV = [
  "AI_AGENT", "CURSOR_TRACE_ID", "CURSOR_AGENT", "CURSOR_EXTENSION_HOST_ROLE", "GEMINI_CLI", "CODEX_SANDBOX", "CODEX_CI",
  "CODEX_THREAD_ID", "ANTIGRAVITY_AGENT", "AUGMENT_AGENT", "OPENCODE_CLIENT", "CLAUDECODE", "CLAUDE_CODE", "CLAUDE_CODE_IS_COWORK",
  "REPL_ID", "COPILOT_MODEL", "COPILOT_ALLOW_ALL", "COPILOT_GITHUB_TOKEN", "CLAUDE_CODE_ENTRYPOINT",
];
export const CI_ENV = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TRAVIS", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION"];

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

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const key of [...AGENT_ENV, ...CI_ENV, "SKILL_LIBRARY_TYPESAFE_API_KEY", "SKILL_LIBRARY_TYPESAFE_API_BASE", "GITHUB_TOKEN", "GH_TOKEN"]) {
    delete env[key];
  }

  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    SKILL_LIBRARY_DIR: path.join(home, "library"),
    SKILL_LIBRARY_NO_GATEWAY: "1",
    SKILL_LIBRARY_RETRY_BASE_MS: "10",
    SKILL_LIBRARY_NPM_REGISTRY: "http://127.0.0.1:1",
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

export function run(
  sb: Sandbox,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string } = {},
): Promise<RunResult> {
  return runFile(sb, BIN, args, opts);
}

/** A fake npm registry answering dist-tags requests with `tags`. */
export async function registry(tags: Record<string, string>): Promise<{ url: string; close: () => void }> {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(tags));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export interface FakeNpm {
  /** npm's global node_modules folder. */
  root: string;
  /** A PATH with the fake npm, npm's global bin folder and git. */
  path: string;
  /** Pretend `npm i -g skill-library@<version>` already ran. */
  install(version: string): Promise<void>;
  /** The `npm i` calls made, one per line. */
  log(): Promise<string[]>;
}

/**
 * A fake npm whose global installs copy the built CLI into a folder inside the sandbox. The fake
 * package.json says `"type": "module"` like the real one: Node before 22.12 doesn't detect that the
 * extensionless bundle is ESM.
 */
export async function fakeNpm(sb: Sandbox): Promise<FakeNpm> {
  const prefix = path.join(sb.root, "npm-prefix");
  const root = path.join(prefix, "lib", "node_modules");
  const bin = path.join(prefix, "bin");
  const fakebin = path.join(sb.root, "fakebin");
  const log = path.join(sb.root, "npm.log");

  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(fakebin, { recursive: true });
  const pkg = path.join(root, "skill-library");

  await fsp.writeFile(
    path.join(fakebin, "npm"),
    `#!/bin/sh
case "$1" in
  --version) echo 10.0.0 ;;
  root) echo "${root}" ;;
  i)
    v="\${3#skill-library@}"
    mkdir -p "${pkg}/dist" "${bin}"
    cp "${BIN}" "${pkg}/dist/skill-library"
    printf '{"version":"%s","type":"module"}' "$v" > "${pkg}/package.json"
    ln -sf "${pkg}/dist/skill-library" "${bin}/skill-library"
    echo "$@" >> "${log}" ;;
esac
`,
  );
  await fsp.chmod(path.join(fakebin, "npm"), 0o755);
  const gitDir = path.dirname(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());

  return {
    root,
    path: [fakebin, bin, gitDir].join(path.delimiter),
    async install(version) {
      await fsp.mkdir(path.join(pkg, "dist"), { recursive: true });
      await fsp.mkdir(bin, { recursive: true });
      await fsp.copyFile(BIN, path.join(pkg, "dist", "skill-library"));
      await fsp.writeFile(path.join(pkg, "package.json"), JSON.stringify({ version, type: "module" }));
      await fsp.symlink(path.join(pkg, "dist", "skill-library"), path.join(bin, "skill-library")).catch(() => {});
    },
    async log() {
      const text = await fsp.readFile(log, "utf8").catch(() => "");

      return text.split("\n").filter(Boolean);
    },
  };
}

/** Run a copy of the CLI at `bin`. */
export function runFile(
  sb: Sandbox,
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string } = {},
): Promise<RunResult> {
  const env = { ...sb.env };

  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd ?? sb.root,
      env,
      stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));

    if (opts.stdin !== undefined) {
      proc.stdin!.end(opts.stdin);
    }
  });
}

export function skillMd(name: string, description: string, body = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${body}`;
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel);

    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
  }
}

export function git(sb: Sandbox, cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: sb.env, encoding: "utf8" }).trim();
}

/** A bare repo (file:// URL) with `files` committed; returns url and the work tree to commit more. */
export async function gitRepo(
  sb: Sandbox,
  name: string,
  files: Record<string, string>,
  opts: { allowSha?: boolean } = {},
) {
  const work = path.join(sb.root, "repos", `${name}-work`);
  const bare = path.join(sb.root, "repos", `${name}.git`);

  await fsp.mkdir(work, { recursive: true });
  git(sb, work, ["init", "-q", "-b", "main"]);
  await writeFiles(work, files);
  git(sb, work, ["add", "-A"]);
  git(sb, work, ["commit", "-q", "-m", "init"]);
  git(sb, sb.root, ["clone", "-q", "--bare", work, bare]);

  if (opts.allowSha !== false) {
    git(sb, bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  }

  git(sb, bare, ["config", "uploadpack.allowFilter", "true"]);
  git(sb, work, ["remote", "add", "origin", bare]);
  const url = `file://${bare}`;

  const commit = async (more: Record<string, string>, remove: string[] = []): Promise<string> => {
    await writeFiles(work, more);

    for (const relPath of remove) {
      await fsp.rm(path.join(work, relPath), { recursive: true, force: true });
    }

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
