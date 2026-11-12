// A "world" per test: a sandboxed HOME, the npm-installed skill-library on PATH, local git hosting
// (github.com is rewritten to local bare repositories, so `owner/repo` sources work offline) and
// helpers to run the CLI the way a user does.
import { execFileSync, spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inject, onTestFinished } from "vitest";
import { AGENT_ENV, CI_ENV } from "../helpers.ts";
import type { E2EInfo } from "./global-setup.ts";

export const e2e = (): E2EInfo => inject("e2e");

export interface Result {
  code: number;
  /** stdout/stderr with terminal escapes stripped (the CLI keeps 256-color codes even with NO_COLOR). */
  stdout: string;
  stderr: string;
  rawStdout: string;
  rawStderr: string;
  /** stdout parsed as JSON (throws with the output when it isn't). */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- callers may name the JSON shape
  json<T = any>(): T;
}

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** Run another copy than the world's `skill-library` on PATH. */
  bin?: string;
}

export interface Repo {
  /** URL to give the CLI (file://… or https://github.com/owner/repo.git). */
  url: string;
  /** owner/repo for github repos. */
  slug?: string;
  bare: string;
  work: string;
  head: string;
  /** Commit (and push) more changes; returns the new head. `remove` deletes paths first. */
  commit(files: Record<string, string>, remove?: string[], message?: string): Promise<string>;
  tag(name: string): void;
  branch(name: string, files: Record<string, string>): Promise<string>;
}

export interface World {
  root: string;
  home: string;
  store: string;
  /** Folder holding fake executables (agents, …); first on PATH after skill-library. */
  fakeBin: string;
  /** Folder with the skill-library executable this world runs. */
  binDir: string;
  env: Record<string, string>;
  run(args: string[], opts?: RunOpts): Promise<Result>;
  /** run() that must exit 0; returns the result. */
  ok(args: string[], opts?: RunOpts): Promise<Result>;
  /** A folder (created) under the world root. */
  dir(name: string): Promise<string>;
  /** Write files under `dir` (created as needed). */
  write(dir: string, files: Record<string, string>): Promise<string>;
  /** A git repository reachable at file://… */
  repo(name: string, files: Record<string, string>): Promise<Repo>;
  /** A git repository reachable as github.com/<owner>/<repo> (rewritten to a local bare repo). */
  github(slug: string, files: Record<string, string>): Promise<Repo>;
  /** An empty bare repository (file://…), e.g. for sync. */
  emptyRemote(name: string): Promise<string>;
  git(cwd: string, args: string[]): string;
  /** A fake agent executable that records its arguments and exits with `code`. */
  fakeAgent(command: string, code?: number): Promise<{ calls(): Promise<string[][]> }>;
  /** Another machine: same remotes and git hosting, its own HOME and library. */
  machine(name: string): Promise<World>;
}

/**
 * Git config lines that send every push to a remote host (https, ssh, git) to a path that doesn't
 * exist, so no test can ever change a repository outside the sandbox. Pushes to the sandbox's own
 * bare repositories (file:// URLs and plain paths) are unaffected.
 */
export const PUSH_BLOCK = [
  "[url \"file:///nonexistent/e2e-push-blocked/\"]",
  ...["https://", "http://", "ssh://", "git://", "git@"].map((prefix) => `\tpushInsteadOf = ${prefix}`),
];

export function skillMd(name: string, description: string, body = "", extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n${body}\n`;
}

function systemPath(): string[] {
  const dirs = new Set<string>([path.dirname(process.execPath)]);

  for (const cmd of ["git", "npm", "tar", "sh"]) {
    try {
      dirs.add(path.dirname(execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim()));
    } catch {
      // not installed; the tests that need it will say so
    }
  }

  dirs.add("/usr/bin");
  dirs.add("/bin");

  return [...dirs];
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel);

    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
  }
}

interface Shared {
  root: string;
  githubRoot: string;
  gitconfig: string;
  counter: { value: number };
}

export interface WorldOpts {
  /** Use this skill-library bin folder instead of the shared npm install. */
  binDir?: string;
  /** Extra env for every run. */
  env?: Record<string, string>;
}

/** A fresh world; removed when the test finishes (set E2E_KEEP=1 to keep it). */
export async function world(opts: WorldOpts = {}): Promise<World> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "sl-e2e-world-")));
  const githubRoot = path.join(root, "github");
  const gitconfig = path.join(root, "gitconfig");

  await fsp.mkdir(githubRoot, { recursive: true });
  await fsp.writeFile(
    gitconfig,
    [
      `[url "file://${githubRoot}/"]`,
      "\tinsteadOf = https://github.com/",
      "\tinsteadOf = git@github.com:",
      "\tinsteadOf = ssh://git@github.com/",
      ...PUSH_BLOCK,
      "[init]",
      "\tdefaultBranch = main",
      "[protocol \"file\"]",
      "\tallow = always",
      "[advice]",
      "\tdetachedHead = false",
      "",
    ].join("\n"),
  );
  onTestFinished(async () => {
    if (!process.env.E2E_KEEP) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  return makeWorld({ root, githubRoot, gitconfig, counter: { value: 0 } }, "machine", opts);
}

async function makeWorld(shared: Shared, name: string, opts: WorldOpts): Promise<World> {
  const base = path.join(shared.root, name);
  const home = path.join(base, "home");
  const fakeBin = path.join(base, "fakebin");

  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(fakeBin, { recursive: true });
  const binDir = opts.binDir ?? e2e().binDir;

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toLowerCase().startsWith("npm_")) {
      env[key] = value;
    }
  }

  for (const key of [...AGENT_ENV, ...CI_ENV, "SKILL_LIBRARY_DIR", "SKILL_LIBRARY_TYPESAFE_API_KEY", "SKILL_LIBRARY_TYPESAFE_API_BASE", "SKILL_LIBRARY_NO_GATEWAY", "SKILLS_API_URL", "GITHUB_TOKEN", "GH_TOKEN", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    delete env[key];
  }

  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    PATH: [binDir, fakeBin, ...systemPath()].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    TMPDIR: path.join(base, "tmp"),
    // Nothing may reach the network: every service points at a closed port unless a test starts a fake.
    SKILL_LIBRARY_NPM_REGISTRY: "http://127.0.0.1:1",
    SKILL_LIBRARY_TYPESAFE_API_BASE: "http://127.0.0.1:1",
    SKILLS_API_URL: "http://127.0.0.1:1",
    SKILL_LIBRARY_RETRY_BASE_MS: "5",
    SKILL_LIBRARY_SYNC_TTL: "999999",
    npm_config_registry: "http://127.0.0.1:1",
    npm_config_prefix: path.join(base, "npm-global"),
    npm_config_cache: path.join(base, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: shared.gitconfig,
    GIT_AUTHOR_NAME: "E2E",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "E2E",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...opts.env,
  });
  await fsp.mkdir(env.TMPDIR!, { recursive: true });

  const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const run = (args: string[], runOpts: RunOpts = {}): Promise<Result> => {
    const childEnv = { ...env };

    for (const [key, value] of Object.entries(runOpts.env ?? {})) {
      if (value === undefined) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }

    const bin = runOpts.bin ?? path.join(binDir, "skill-library");

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { cwd: runOpts.cwd ?? base, env: childEnv, stdio: [runOpts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      proc.on("error", reject);
      proc.on("close", (code) =>
        resolve({
          code: code ?? 1,
          stdout: plain(stdout),
          stderr: plain(stderr),
          rawStdout: stdout,
          rawStderr: stderr,
          json() {
            try {
              return JSON.parse(stdout);
            } catch {
              throw new Error(`stdout is not one JSON value (exit ${String(code)}):\n--- stdout\n${stdout}\n--- stderr\n${stderr}`);
            }
          },
        }),
      );

      if (runOpts.stdin !== undefined) {
        proc.stdin!.end(runOpts.stdin);
      }
    });
  };

  const makeRepo = async (
    bare: string,
    work: string,
    url: string,
    files: Record<string, string>,
    slug?: string,
  ): Promise<Repo> => {
    await fsp.mkdir(work, { recursive: true });
    git(work, ["init", "-q", "-b", "main"]);
    await writeFiles(work, files);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "--allow-empty", "-m", "init"]);
    await fsp.mkdir(path.dirname(bare), { recursive: true });
    git(shared.root, ["clone", "-q", "--bare", work, bare]);
    git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    git(bare, ["config", "uploadpack.allowFilter", "true"]);
    git(work, ["remote", "add", "origin", bare]);
    git(work, ["fetch", "-q", "origin"]);
    git(work, ["branch", "-q", "--set-upstream-to=origin/main", "main"]);
    const repo: Repo = {
      url,
      ...(slug ? { slug } : {}),
      bare,
      work,
      head: git(work, ["rev-parse", "HEAD"]),
      async commit(more, remove = [], message = "change") {
        await writeFiles(work, more);

        for (const relPath of remove) {
          await fsp.rm(path.join(work, relPath), { recursive: true, force: true });
        }

        git(work, ["add", "-A"]);
        git(work, ["commit", "-q", "--allow-empty", "-m", message]);
        git(work, ["push", "-q", "origin", "HEAD:main"]);
        repo.head = git(work, ["rev-parse", "HEAD"]);

        return repo.head;
      },
      tag(tagName) {
        git(work, ["tag", tagName]);
        git(work, ["push", "-q", "origin", tagName]);
      },
      async branch(branchName, more) {
        git(work, ["checkout", "-q", "-b", branchName]);
        await writeFiles(work, more);
        git(work, ["add", "-A"]);
        git(work, ["commit", "-q", "-m", `on ${branchName}`]);
        git(work, ["push", "-q", "origin", branchName]);
        const sha = git(work, ["rev-parse", "HEAD"]);

        git(work, ["checkout", "-q", "main"]);

        return sha;
      },
    };

    return repo;
  };

  const self: World = {
    root: base,
    home,
    store: path.join(home, ".local", "share", "skill-library"),
    fakeBin,
    binDir,
    env,
    run,
    async ok(args, runOpts) {
      const result = await run(args, runOpts);

      if (result.code !== 0) {
        throw new Error(`skill-library ${args.join(" ")} exited ${result.code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`);
      }

      return result;
    },
    async dir(dirName) {
      const dirPath = path.join(base, dirName);

      await fsp.mkdir(dirPath, { recursive: true });

      return dirPath;
    },
    async write(dir, files) {
      await writeFiles(dir, files);

      return dir;
    },
    async repo(repoName, files) {
      const id = ++shared.counter.value;
      const bare = path.join(shared.root, "remotes", `${repoName}.git`);

      return makeRepo(bare, path.join(shared.root, "work", `${repoName}-${id}`), `file://${bare}`, files);
    },
    async github(slug, files) {
      const id = ++shared.counter.value;
      const bare = path.join(shared.githubRoot, `${slug}.git`);

      return makeRepo(bare, path.join(shared.root, "work", `${slug.replace("/", "-")}-${id}`), `https://github.com/${slug}.git`, files, slug);
    },
    async emptyRemote(remoteName) {
      const bare = path.join(shared.root, "remotes", `${remoteName}.git`);

      await fsp.mkdir(bare, { recursive: true });
      git(bare, ["init", "-q", "--bare", "-b", "main"]);

      return `file://${bare}`;
    },
    git,
    async fakeAgent(command, code = 0) {
      const log = path.join(base, `${command}.calls`);

      // One JSON array per call: the arguments exactly as received.
      await fsp.writeFile(
        path.join(fakeBin, command),
        `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(${code});\n`,
      );
      await fsp.chmod(path.join(fakeBin, command), 0o755);

      return {
        async calls() {
          const text = await fsp.readFile(log, "utf8").catch(() => "");

          return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        },
      };
    },
    machine(machineName) {
      return makeWorld(shared, machineName, opts);
    },
  };

  return self;
}

/** Strip ANSI escapes (some output keeps 256-color codes even with NO_COLOR). */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath).then(
    () => true,
    () => false,
  );
}

export async function readJson<T = any>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}
