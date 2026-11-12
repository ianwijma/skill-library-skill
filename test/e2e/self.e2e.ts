// `self setup | update | doctor`, with the real npm installing the packed package from a local
// registry. Each world starts like a machine that only has `npx skill-library`: the shared install
// is run by absolute path (as npx would) and is NOT on PATH; npm's global prefix is the world's own.
import { describe, expect, onTestFinished, test } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { e2e, exists, skillMd, world, type Result, type World } from "./harness.ts";
import { expectUsageError } from "./contract.ts";
import { fakeRegistry, type FakeRegistry } from "./fakes.ts";
import { assertDoctorJson, validateGateway } from "./validate.ts";

const KEY = "SKILL_LIBRARY_TYPESAFE_API_KEY";

interface SelfWorld {
  testWorld: World;
  reg: FakeRegistry;
  /** npm's global prefix and its bin folder (on PATH). */
  prefix: string;
  prefixBin: string;
  /** The globally installed copy (after setup). */
  installed: string;
  /** Run the copy npx would run (the shared install, by absolute path). */
  npx(args: string[], env?: Record<string, string | undefined>): Promise<Result>;
  /** Run the globally installed copy. */
  global(args: string[], env?: Record<string, string | undefined>): Promise<Result>;
  claudeDir: string;
  agentsDir: string;
}

/** `pre`: npx runs an older prerelease copy instead of this checkout. */
async function selfWorld(
  opts: { key?: boolean; latest?: string; tags?: Record<string, string>; pre?: boolean } = {},
): Promise<SelfWorld> {
  const testWorld = await world();
  const reg = await fakeRegistry(
    [e2e().tarball, e2e().nextTarball, e2e().rcTarball, e2e().preTarball],
    opts.tags ?? { latest: opts.latest ?? e2e().version },
  );

  onTestFinished(() => reg.close());
  const prefix = testWorld.env.npm_config_prefix!;
  const prefixBin = path.join(prefix, "bin");

  // PATH: npm's global bin first (where setup installs), never the shared install.
  testWorld.env.PATH = [
    prefixBin,
    ...testWorld.env.PATH!.split(path.delimiter).filter((dir) => dir !== e2e().binDir),
  ].join(path.delimiter);
  testWorld.env.SKILL_LIBRARY_NPM_REGISTRY = reg.url;
  testWorld.env.npm_config_registry = reg.url;

  if (opts.key !== false) {
    testWorld.env[KEY] = "test-key";
  }

  const installed = path.join(prefixBin, "skill-library");

  return {
    testWorld,
    reg,
    prefix,
    prefixBin,
    installed,
    npx: (args, env) => testWorld.run(args, { env: env ?? {}, ...(opts.pre ? { bin: e2e().preBin } : {}) }),
    global: (args, env) => testWorld.run(args, { bin: installed, env: env ?? {} }),
    claudeDir: path.join(testWorld.home, ".claude", "skills"),
    agentsDir: path.join(testWorld.home, ".agents", "skills"),
  };
}

/** A PATH folder holding only symlinks to these commands (to take npm or git off PATH). */
async function pathWith(testWorld: World, name: string, commands: string[]): Promise<string> {
  const dir = await testWorld.dir(`path-${name}`);

  for (const cmd of commands) {
    const target = cmd === "node" ? process.execPath : await fsp.realpath(execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim());

    await fsp.symlink(target, path.join(dir, cmd));
  }

  return dir;
}

async function listDir(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir).catch(() => [] as string[])).sort();
}

describe("self: arguments", () => {
  test("help, unknown subcommands, stray positionals and bad agents", async () => {
    const testWorld = await world();

    for (const args of [["self"], ["self", "help"], ["self", "--help"]]) {
      const result = await testWorld.ok(args);

      expect(result.stdout).toContain("skill-library self <command>");

      for (const sub of ["setup", "update", "doctor"]) {
        expect(result.stdout).toContain(sub);
      }
    }

    expectUsageError(await testWorld.run(["self", "frobnicate"]), "frobnicate");

    for (const sub of ["setup", "doctor", "update"]) {
      expectUsageError(await testWorld.run(["self", sub, "extra"]), "extra");
    }

    for (const sub of ["setup", "doctor"]) {
      const invalid = await testWorld.run(["self", sub, "-a", "nope"]);

      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("Invalid agents: nope");
      expect(invalid.stderr).toContain("claude-code");
      const star = await testWorld.run(["self", sub, "-a", "*"]);

      expect(star.code).toBe(1);
      expect(star.stderr).toContain("Invalid agents: *");
      expect(star.stderr).toContain("Name the agents.");
      const noGlobal = await testWorld.run(["self", sub, "--agent", "eve"]);

      expect(noGlobal.code).toBe(1);
      expect(noGlobal.stderr).toContain("has no global skills folder");
      expectUsageError(await testWorld.run(["self", sub, "-a"]), "-a", "--agent");
    }

    // Nothing was written anywhere.
    expect(await listDir(testWorld.home)).toEqual([]);
  });
});

describe("self doctor", () => {
  test("fresh machine: install, gateway and key fail with fixes; git ok; writes nothing", async () => {
    const sandbox = await selfWorld({ key: false });
    const result = await sandbox.npx(["self", "doctor"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("✗ skill-library isn't installed");
    expect(result.stdout).toContain("Install it: npx skill-library self setup");
    expect(result.stdout).toContain(`skill-library ${e2e().version} is the newest release`);
    expect(result.stdout).toContain("No agents found on this machine");
    expect(result.stdout).toContain(`${KEY} is not set`);
    expect(result.stdout).toContain("https://console.typesafe.ai/keys");
    expect(result.stdout).toContain(`export ${KEY}='<your TypeSafe API key>'`);
    expect(result.stdout).toContain("✓ git is installed");
    expect(result.stdout).toContain("3 problem(s) found. Fix them and run skill-library self doctor again.");

    const report = (await sandbox.npx(["self", "doctor", "--json"])).json();

    assertDoctorJson(report);
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.status]))).toEqual({ install: "fail", release: "ok", gateway: "fail", "api-key": "fail", git: "ok" });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "api-key")!.fix).toContain("https://console.typesafe.ai/keys");

    // Read-only: no agent folders, nothing installed, nothing downloaded.
    expect(await listDir(sandbox.testWorld.home)).toEqual([]);
    expect(await exists(path.join(sandbox.prefix, "lib", "node_modules", "skill-library"))).toBe(false);
    expect(sandbox.reg.downloads()).toEqual([]);
  });

  test("-a checks only the named agents; the key counts once set; exit code follows the checks", async () => {
    const sandbox = await selfWorld();
    const result = await sandbox.npx(["self", "doctor", "-a", "claude-code", "codex", "--json"]);

    expect(result.code).toBe(1);
    const report = result.json();

    assertDoctorJson(report);
    const gw = report.checks.find((check) => check.id === "gateway")!;

    expect(gw.status).toBe("fail");
    expect(gw.message).toBe("The skill-library skill is missing for Claude Code, Codex");
    expect(gw.fix).toBe("Run skill-library self setup");
    expect(report.checks.find((check) => check.id === "api-key")).toMatchObject({ status: "ok", message: `${KEY} is set` });
    expect(await exists(path.join(sandbox.testWorld.home, ".claude"))).toBe(false);
  });

  test("release check: warns when the registry has a newer release, and when it can't be reached", async () => {
    const sandbox = await selfWorld({ latest: e2e().nextVersion });
    const newer = (await sandbox.npx(["self", "doctor", "--json"])).json();

    assertDoctorJson(newer);
    expect(newer.checks.find((check) => check.id === "release")).toEqual({
      id: "release",
      status: "warn",
      message: `skill-library ${e2e().nextVersion} is available (you have ${e2e().version})`,
      fix: "Run npx skill-library self setup",
    });
    const offline = (await sandbox.npx(["self", "doctor", "--json"], { SKILL_LIBRARY_NPM_REGISTRY: "http://127.0.0.1:1" })).json();

    assertDoctorJson(offline);
    const rel = offline.checks.find((check) => check.id === "release")!;

    expect(rel.status).toBe("warn");
    expect(rel.message).toContain("Couldn't check for a newer release");
    // A warning alone doesn't fail: only fails count.
    expect(offline.ok).toBe(!offline.checks.some((check) => check.status === "fail"));
  });

  test("--agent (long form) and --agent=; an unknown option is named", async () => {
    const sandbox = await selfWorld();

    expect((await sandbox.npx(["self", "doctor", "--bogus"])).stderr).toContain("--bogus");

    for (const args of [["--agent", "claude-code"], ["--agent=claude-code"]]) {
      const result = await sandbox.npx(["self", "doctor", ...args, "--json"]);

      expect(result.code, args.join(" ")).toBe(1);
      const report = result.json();

      assertDoctorJson(report);
      expect(report.checks.find((check) => check.id === "gateway")!.message).toBe("The skill-library skill is missing for Claude Code");
    }

    expectUsageError(await sandbox.npx(["self", "doctor", "--agent="]), "--agent");
  });

  test("everything in place → exit 0; npm's bin folder off PATH → install fails with the folder to add", async () => {
    const sandbox = await selfWorld();

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    expect((await sandbox.npx(["self", "setup"])).code).toBe(0);
    const good = await sandbox.global(["self", "doctor"]);

    expect(good.code).toBe(0);
    expect(good.stdout).toContain("All good.");
    // The same installed copy, run with npm's global bin folder missing from PATH.
    const offPath = sandbox.testWorld.env.PATH!.split(path.delimiter)
      .filter((dir) => dir !== sandbox.prefixBin)
      .join(path.delimiter);
    const result = await sandbox.global(["self", "doctor", "--json"], { PATH: offPath });

    expect(result.code).toBe(1);
    const report = result.json();

    assertDoctorJson(report);
    expect(report.checks.find((check) => check.id === "install")).toEqual({
      id: "install",
      status: "fail",
      message: "skill-library is installed, but npm's global bin folder isn't on PATH, so your agents can't run it",
      fix: `Add ${sandbox.prefixBin} to PATH in your shell profile.`,
    });
  });

  test("git missing: the git check fails with where to get it", async () => {
    const sandbox = await selfWorld();
    const onlyNode = await pathWith(sandbox.testWorld, "no-git", ["node", "npm"]);
    const result = await sandbox.npx(["self", "doctor", "--json"], { PATH: onlyNode });

    expect(result.code).toBe(1);
    const report = result.json();

    assertDoctorJson(report);
    expect(report.checks.find((check) => check.id === "git")).toMatchObject({ status: "fail", fix: "Install it from https://git-scm.com" });
  });

  test("on PATH but not installed with npm -g: warns that self update can't update it", async () => {
    const sandbox = await selfWorld();
    const report = (await sandbox.npx(["self", "doctor", "--json"], { PATH: `${e2e().binDir}${path.delimiter}${String(sandbox.testWorld.env.PATH)}` })).json();

    assertDoctorJson(report);
    const install = report.checks.find((check) => check.id === "install")!;

    expect(install.status).toBe("warn");
    expect(install.message).toContain("wasn't installed with npm -g");
  });
});

describe("self setup", () => {
  test("without a key: the preflight fails and nothing is installed", async () => {
    const sandbox = await selfWorld({ key: false });

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    const result = await sandbox.npx(["self", "setup"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Checking this machine");
    expect(result.stdout).toMatch(/✓ npm \S+ can install globally/);
    expect(result.stdout).toContain(`${KEY} is not set`);
    expect(result.stdout).toContain("Fix the problems above, then run setup again. Nothing was installed.");
    expect(await exists(sandbox.prefix)).toBe(false);
    expect(sandbox.reg.downloads()).toEqual([]);
    expect(await exists(path.join(sandbox.claudeDir, "skill-library"))).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)("an npm prefix you can't write: the preflight fails with the npm docs link", async () => {
    const sandbox = await selfWorld();

    await fsp.mkdir(path.join(sandbox.prefix, "lib", "node_modules"), { recursive: true });
    await fsp.chmod(path.join(sandbox.prefix, "lib", "node_modules"), 0o500);
    onTestFinished(() => fsp.chmod(path.join(sandbox.prefix, "lib", "node_modules"), 0o700));
    const result = await sandbox.npx(["self", "setup"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("isn't writable by you");
    expect(result.stdout).toContain("resolving-eacces-permissions-errors");
    expect(result.stdout).toContain("Nothing was installed.");
    expect(sandbox.reg.downloads()).toEqual([]);
  });

  test("installs with real npm, hands over, places the gateway, and re-running it changes nothing", async () => {
    const sandbox = await selfWorld();

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });

    const first = await sandbox.npx(["self", "setup"]);

    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain(`Installing ${e2e().version}`);
    expect(first.stdout).toContain(`$ npm i -g skill-library@${e2e().version}`);
    expect(first.stdout).toContain("Installed the skill-library skill for Claude Code");
    expect(first.stdout).toContain(`skill-library ${e2e().version} is installed and on PATH`);
    expect(first.stdout).toContain("All good.");
    expect(sandbox.reg.downloads()).toEqual([e2e().version]);

    // The real global install: package, bin link, and it runs.
    const pkg = JSON.parse(await fsp.readFile(path.join(sandbox.prefix, "lib", "node_modules", "skill-library", "package.json"), "utf8"));

    expect(pkg.version).toBe(e2e().version);
    expect((await sandbox.global(["--version"])).stdout).toBe(`${e2e().version}\n`);
    await validateGateway([sandbox.claudeDir]);
    // Codex isn't on this machine: its folder is left alone.
    expect(await exists(sandbox.agentsDir)).toBe(false);

    const doctor = (await sandbox.global(["self", "doctor", "--json"])).json();

    assertDoctorJson(doctor);
    expect(doctor.checks.every((check) => check.status === "ok")).toBe(true);

    const again = await sandbox.npx(["self", "setup"]);

    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`${e2e().version} is installed and the newest release`);
    expect(again.stdout).toContain("Already up to date for Claude Code");
    expect(again.stdout).toContain("All good.");
    expect(sandbox.reg.downloads()).toEqual([e2e().version]);

    // Running the installed copy itself skips the hand-over.
    const local = await sandbox.global(["self", "setup"]);

    expect(local.code).toBe(0);
    expect(local.stdout).toContain("Already up to date for Claude Code");
  });

  test("-a installs the gateway only for the named agents", async () => {
    const sandbox = await selfWorld();

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    const result = await sandbox.npx(["self", "setup", "-a", "codex"]);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Installed the skill-library skill for Codex");
    await validateGateway([sandbox.agentsDir]);
    expect(await exists(path.join(sandbox.claudeDir, "skill-library"))).toBe(false);
  });

  test("--agent (long form) works like -a; several agents at once", async () => {
    const sandbox = await selfWorld();
    const result = await sandbox.npx(["self", "setup", "--agent", "claude-code", "codex"]);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Installed the skill-library skill for");
    await validateGateway([sandbox.claudeDir, sandbox.agentsDir]);
  });

  test("npm or git missing: the preflight fails and nothing is installed", async () => {
    const sandbox = await selfWorld();
    const noNpm = await sandbox.npx(["self", "setup"], { PATH: await pathWith(sandbox.testWorld, "no-npm", ["node", "git"]) });

    expect(noNpm.code).toBe(1);
    expect(noNpm.stdout).toContain("npm is not installed or not on PATH");
    expect(noNpm.stdout).toContain("https://nodejs.org");
    expect(noNpm.stdout).toContain("Nothing was installed.");
    const noGit = await sandbox.npx(["self", "setup"], { PATH: await pathWith(sandbox.testWorld, "no-git", ["node", "npm"]) });

    expect(noGit.code).toBe(1);
    expect(noGit.stdout).toContain("git is not installed or not on PATH");
    expect(noGit.stdout).toContain("Nothing was installed.");
    expect(sandbox.reg.downloads()).toEqual([]);
    expect(await exists(path.join(sandbox.prefix, "lib", "node_modules", "skill-library"))).toBe(false);
  });

  test("no agents detected and none named: setup installs, then reports the gateway problem (exit 1)", async () => {
    const sandbox = await selfWorld();
    const result = await sandbox.npx(["self", "setup"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("No agents found on this machine");
    expect(result.stdout).toContain("1 problem(s) found. Fix them and run skill-library self setup again.");
    expect(sandbox.reg.downloads()).toEqual([e2e().version]);
  });

  test("a newer release on npm: setup moves the global install to it", async () => {
    const sandbox = await selfWorld();

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    await sandbox.npx(["self", "setup"]);
    sandbox.reg.distTags = { latest: e2e().nextVersion };
    const result = await sandbox.npx(["self", "setup"]);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`Updating ${e2e().version} → ${e2e().nextVersion}`);
    expect(sandbox.reg.downloads()).toEqual([e2e().version, e2e().nextVersion]);
    expect((await sandbox.global(["--version"])).stdout).toBe(`${e2e().nextVersion}\n`);
    await validateGateway([sandbox.claudeDir]);
  });
});

describe("self update", () => {
  test("not installed with npm -g → exit 1", async () => {
    const sandbox = await selfWorld();
    const result = await sandbox.npx(["self", "update"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("isn't installed with npm -g, so there is nothing to update");
    expect(result.stderr).toContain("npx skill-library self setup");
    expect(sandbox.reg.downloads()).toEqual([]);
  });

  test("installs the newer release with real npm and refreshes the gateway only where it already is", async () => {
    const sandbox = await selfWorld();

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    expect((await sandbox.npx(["self", "setup"])).code).toBe(0);

    // Claude Code gets an outdated gateway; Codex is on the machine but never had one.
    await sandbox.testWorld.write(path.join(sandbox.claudeDir, "skill-library"), { "SKILL.md": skillMd("skill-library", "an old gateway") });
    await fsp.mkdir(path.join(sandbox.testWorld.home, ".codex"), { recursive: true });
    const outdated = await sandbox.global(["self", "doctor"]);

    expect(outdated.code).toBe(1);
    expect(outdated.stdout).toContain("The skill-library skill is missing for Codex; outdated for Claude Code");

    const current = await sandbox.global(["self", "update"]);

    expect(current.code).toBe(0);
    expect(current.stdout).toContain(`skill-library ${e2e().version} is the newest release`);
    expect(current.stdout).toContain("Installed the skill-library skill for Claude Code");
    await validateGateway([sandbox.claudeDir]);

    sandbox.reg.distTags = { latest: e2e().nextVersion };
    const result = await sandbox.global(["self", "update"]);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`Updating skill-library ${e2e().version} → ${e2e().nextVersion}`);
    expect(sandbox.reg.downloads()).toEqual([e2e().version, e2e().nextVersion]);
    expect((await sandbox.global(["--version"])).stdout).toBe(`${e2e().nextVersion}\n`);
    expect(result.stdout).toContain("Already up to date for Claude Code");
    await validateGateway([sandbox.claudeDir]);
    expect(await exists(path.join(sandbox.agentsDir, "skill-library"))).toBe(false);

    const again = await sandbox.global(["self", "update"]);

    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`skill-library ${e2e().nextVersion} is the newest release`);
    expect(sandbox.reg.downloads()).toHaveLength(2);
  });

  test("no agent has the gateway: says how to install it", async () => {
    const sandbox = await selfWorld();

    expect((await sandbox.npx(["self", "setup", "-a", "codex"])).code).toBe(0);
    await fsp.rm(path.join(sandbox.agentsDir, "skill-library"), { recursive: true });
    const result = await sandbox.global(["self", "update"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No agent has the skill-library skill yet. Install it with: skill-library self setup");
  });

  test("npm missing → exit 2", async () => {
    const sandbox = await selfWorld();
    const result = await sandbox.npx(["self", "update"], { PATH: await pathWith(sandbox.testWorld, "no-npm", ["node", "git"]) });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("npm is not installed or not on PATH");
  });

  test("registry unreachable → exit 2", async () => {
    const sandbox = await selfWorld();

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    expect((await sandbox.npx(["self", "setup"])).code).toBe(0);
    const result = await sandbox.global(["self", "update"], { SKILL_LIBRARY_NPM_REGISTRY: "http://127.0.0.1:1" });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Couldn't check for a newer release");
  });
});

// A stable install never moves to a prerelease, whatever the dist-tags say; a prerelease install
// also follows `next` and takes whichever release is newest. The prerelease side starts from a
// repacked 98.0.0-rc.0, so these tests don't depend on this checkout's own version.
describe("self: stable and prerelease releases", () => {
  const { preVersion: version, nextVersion: stable, rcVersion: rc } = e2e();

  test("a prerelease install follows next: doctor warns, self update moves to the release candidate", async () => {
    const sandbox = await selfWorld({ pre: true, latest: version });

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    expect((await sandbox.npx(["self", "setup"])).code).toBe(0);
    expect((await sandbox.global(["--version"])).stdout).toBe(`${version}\n`);

    sandbox.reg.distTags = { latest: version, next: rc };
    const doctor = (await sandbox.global(["self", "doctor", "--json"])).json();

    assertDoctorJson(doctor);
    expect(doctor.checks.find((check) => check.id === "release")).toEqual({
      id: "release",
      status: "warn",
      message: `skill-library ${rc} is available (you have ${version})`,
      fix: "Run skill-library self update",
    });

    const result = await sandbox.global(["self", "update"]);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`Updating skill-library ${version} → ${rc}`);
    expect(sandbox.reg.downloads()).toEqual([version, rc]);
    expect((await sandbox.global(["--version"])).stdout).toBe(`${rc}\n`);
    await validateGateway([sandbox.claudeDir]);
  });

  test("first install from a prerelease copy takes the newest of latest and next", async () => {
    const sandbox = await selfWorld({ pre: true, tags: { latest: stable, next: rc } });

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    const result = await sandbox.npx(["self", "setup"]);

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`Installing ${rc}`);
    expect(sandbox.reg.downloads()).toEqual([rc]);
    expect((await sandbox.global(["--version"])).stdout).toBe(`${rc}\n`);

    // A prerelease current also accepts a release candidate published under latest.
    const rcSandbox = await selfWorld({ pre: true, tags: { latest: rc } });

    await fsp.mkdir(path.join(rcSandbox.testWorld.home, ".claude"), { recursive: true });
    expect((await rcSandbox.npx(["self", "setup"])).stdout).toContain(`Installing ${rc}`);
    expect(rcSandbox.reg.downloads()).toEqual([rc]);
  });

  test("a stable install never moves to a prerelease, even one published under latest", async () => {
    const sandbox = await selfWorld({ latest: stable });

    await fsp.mkdir(path.join(sandbox.testWorld.home, ".claude"), { recursive: true });
    const first = await sandbox.npx(["self", "setup"]);

    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain(`Installing ${stable}`);
    expect((await sandbox.global(["--version"])).stdout).toBe(`${stable}\n`);

    // A release candidate is (mistakenly) tagged latest, and next points at it too.
    sandbox.reg.distTags = { latest: rc, next: rc };

    const doctor = await sandbox.global(["self", "doctor", "--json"]);

    expect(doctor.code).toBe(0);
    const report = doctor.json();

    assertDoctorJson(report);
    expect(report.checks.find((check) => check.id === "release")).toEqual({ id: "release", status: "ok", message: `skill-library ${stable} is the newest release` });

    const update = await sandbox.global(["self", "update"]);

    expect(update.code, update.stdout + update.stderr).toBe(0);
    expect(update.stdout).toContain(`skill-library ${stable} is the newest release`);
    expect(update.stdout).not.toContain("Updating");

    const setup = await sandbox.npx(["self", "setup"]);

    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    expect(setup.stdout).toContain(`${stable} is installed and the newest release`);
    expect(setup.stdout).toContain("All good.");

    // Nothing but the first install was ever downloaded, and the install is still the stable one.
    expect(sandbox.reg.downloads()).toEqual([stable]);
    expect((await sandbox.global(["--version"])).stdout).toBe(`${stable}\n`);
  });
});
