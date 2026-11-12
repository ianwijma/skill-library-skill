// The top level: banner, --version, --help, global options, unknown commands and options.
import { describe, expect, onTestFinished, test } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fakeTypeSafe } from "./fakes.ts";
import { e2e, exists, plain, skillMd, world } from "./harness.ts";
import { validateAll, validateGateway, validateStore } from "./validate.ts";

const COMMANDS = ["add", "a", "install", "i", "experimental_install", "list", "ls", "remove", "rm", "r", "update", "upgrade", "check", "find", "search", "f", "s", "init", "use", "query", "self", "sync"];

describe("sandbox guarantees", () => {
  test("runs in the e2e container, as a regular user", () => {
    expect(process.env.SKILL_LIBRARY_E2E_CONTAINER).toBe("1");
    expect(process.getuid?.()).not.toBe(0);
  });

  test("git can't push to any remote host, from the sandbox or the container's own config", async () => {
    const w = await world();
    const repo = await w.repo("local", { "a.txt": "a" });
    for (const remote of ["https://github.com/ianwijma/skill-library-skill.git", "git@github.com:ianwijma/skill-library-skill.git", "ssh://git@example.com/x.git"]) {
      // Through the sandbox's git config (what every CLI run uses)…
      expect(w.git(repo.work, ["remote", "get-url", "--push", "origin"]).length).toBeGreaterThan(0);
      w.git(repo.work, ["remote", "set-url", "origin", remote]);
      expect(w.git(repo.work, ["remote", "get-url", "--push", "origin"])).toMatch(/^file:\/\/\/nonexistent\/e2e-push-blocked\//);
      // …and through the container user's own global config.
      const own = execFileSync("git", ["-C", repo.work, "remote", "get-url", "--push", "origin"], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: undefined } as NodeJS.ProcessEnv }).trim();
      expect(own).toMatch(/^file:\/\/\/nonexistent\/e2e-push-blocked\//);
    }
  });

  test.skipIf(process.env.E2E_LIVE === "1")("there is no network outside the container", async () => {
    await expect(fetch("https://github.com", { signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
  });
});

describe("root", () => {
  test("the installed binary is the packed package at this checkout's version", async () => {
    const w = await world();
    for (const flag of ["--version", "-v"]) {
      const r = await w.ok([flag]);
      expect(r.stdout).toBe(`${e2e().version}\n`);
      expect(r.stderr).toBe("");
    }
    // Global options are pulled out wherever they appear.
    expect((await w.ok(["--verbose", "--version"])).stdout).toBe(`${e2e().version}\n`);
    expect((await w.ok(["--store", path.join(w.root, "x"), "-v"])).stdout).toBe(`${e2e().version}\n`);
  });

  test("no arguments prints the banner (no logo without a TTY) and exits 0", async () => {
    const w = await world();
    const r = await w.ok([]);
    const out = plain(r.stdout);
    for (const cmd of ["self setup", "add", "query", "use", "remove", "list", "find", "update", "install", "sync", "init"]) expect(out).toContain(`skill-library ${cmd}`);
    expect(out).toContain("try: skill-library add anthropics/skills");
    expect(out).not.toContain("┌─┐");
  });

  test("--help / -h, and --help after any command, print help and exit 0", async () => {
    const w = await world();
    const main = plain((await w.ok(["--help"])).stdout);
    expect(plain((await w.ok(["-h"])).stdout)).toBe(main);
    for (const cmd of ["add", "install", "list", "remove", "update", "check", "find", "init", "query", "sync", "self", "use"]) expect(main).toContain(cmd);
    expect(main).toContain("--store <dir>");
    for (const cmd of COMMANDS) {
      for (const flag of ["--help", "-h"]) {
        const r = await w.run([cmd, flag]);
        expect(r.code, `${cmd} ${flag}`).toBe(0);
        const out = plain(r.stdout);
        if (["remove", "rm", "r"].includes(cmd)) expect(out).toContain("remove");
        else if (cmd === "use") expect(out).toContain("Usage: skill-library use <source>[@<skill>]");
        else if (cmd === "self") expect(out).toContain("skill-library self <command>");
        else expect(out).toBe(main);
      }
    }
    // --help never runs the command: nothing was written.
    expect(await exists(w.store)).toBe(false);
  });

  test("unknown command: message on stdout, exit 1; the old connect points at self setup", async () => {
    const w = await world();
    for (const cmd of ["frobnicate", "lsit", "--frob", "-x"]) {
      const r = await w.run([cmd]);
      expect(r.code, cmd).toBe(1);
      expect(r.stdout).toBe(`Unknown command: ${cmd}\nRun skill-library --help for usage.\n`);
    }
    const old = await w.run(["connect"]);
    expect(old.code).toBe(1);
    expect(old.stderr).toContain("connect was replaced by self setup");
  });

  test("--store / --store= / SKILL_LIBRARY_DIR pick the library; --store without a value fails", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), { "a/SKILL.md": skillMd("a", "Skill A") });
    const viaFlag = path.join(w.root, "lib-flag");
    const viaEq = path.join(w.root, "lib-eq");
    const viaEnv = path.join(w.root, "lib-env");
    await w.ok(["add", path.join(src, "a"), "-g", "-y", "--store", viaFlag]);
    await w.ok(["--store=" + viaEq, "add", path.join(src, "a"), "-g", "-y"]);
    await w.ok(["add", path.join(src, "a"), "-g", "-y"], { env: { SKILL_LIBRARY_DIR: viaEnv } });
    for (const store of [viaFlag, viaEq, viaEnv]) {
      expect(await exists(path.join(store, "index.json")), store).toBe(true);
      const rows = (await w.ok(["list", "-g", "--json", "--store", store])).json();
      expect(rows.map((r: any) => r.name)).toEqual(["a"]);
    }
    // The flag wins over the env var.
    const both = (await w.ok(["list", "-g", "--json", "--store", path.join(w.root, "empty")], { env: { SKILL_LIBRARY_DIR: viaEnv } })).json();
    expect(both).toEqual([]);
    expect(await exists(w.store)).toBe(false);
    const missing = await w.run(["list", "--store"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--store requires a directory");
  });

  test("unknown options warn once each and are ignored; arguments after -- are positionals", async () => {
    const w = await world();
    const r = await w.ok(["list", "-g", "--frobnicate", "--json"]);
    expect(r.stderr).toContain("ignoring unknown option --frobnicate");
    expect(r.json()).toEqual([]);
    const init = await w.ok(["init", "--", "--weird"], { cwd: await w.dir("p") });
    expect(init.stdout).toContain("Initialized skill: --weird");
    expect(await exists(path.join(w.root, "p", "--weird", "SKILL.md"))).toBe(true);
  });

  test("smoke: add → list → the library validates and the gateway is placed in detected agents", async () => {
    const w = await world();
    await w.dir("home/.claude");
    const src = await w.write(await w.dir("src"), { "hello/SKILL.md": skillMd("hello", "Say hello nicely") });
    await w.ok(["add", path.join(src, "hello"), "-g", "-y"]);
    const index = await validateAll(w);
    expect(index.skills.map((s) => s.id)).toEqual([`path://${path.join(src, "hello")}`]);
    await validateGateway([path.join(w.home, ".claude", "skills")]);
  });

  test("--store (anywhere on the line) and --verbose work with every command; the default library is never touched", async () => {
    const w = await world();
    const store = path.join(w.root, "custom-lib");
    const s = ["--store", store];
    const src = await w.write(await w.dir("src"), {
      "a/SKILL.md": skillMd("a", "Skill A"),
      "b/SKILL.md": skillMd("b", "Always on", "", "metadata:\n  always: true\n"),
    });
    const repo = await w.repo("solo", { "SKILL.md": skillMd("solo", "Solo skill") });
    const proj = await w.dir("proj");

    await w.ok([...s, "add", path.join(src, "a"), "-g", "-y", "--verbose"]);
    await w.ok(["add", "--verbose", path.join(src, "b"), "-g", "-y", ...s]);
    await w.ok(["a", repo.url, "-p", "-y", `--store=${store}`], { cwd: proj });
    // --json output stays one JSON value with --verbose anywhere.
    const rows = (await w.ok(["--verbose", "list", "-g", "--json", ...s])).json();
    expect(rows.map((r: any) => r.name).sort()).toEqual(["a", "b", "solo"]);
    expect((await w.ok(["ls", "--json", ...s, "--verbose"], { cwd: proj })).json().map((r: any) => r.name)).toEqual(["solo"]);
    expect((await w.ok(["check", ...s, "--verbose"], { cwd: proj })).stdout).toContain("All skills are up to date.");
    expect((await w.ok(["update", "-g", ...s])).stdout).toMatch(/up to date|Skipped/);
    // query scores the custom library (and prints model/usage on stderr with --verbose).
    const ts = await fakeTypeSafe();
    onTestFinished(() => ts.close());
    const qr = await w.ok(["query", "anything about skill", "--json", ...s, "--verbose"], { env: { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url, SKILL_LIBRARY_TYPESAFE_API_KEY: "k" } });
    expect(qr.stderr).toContain("verbose:");
    expect(ts.lastAsked()).toEqual(["a", "find-skills"]); // solo is project-only; b is always-on
    const q = qr.json();
    expect(q.matches.map((m: any) => m.name)).toContain("b");
    expect(q.matches.find((m: any) => m.name === "b").path.startsWith(store)).toBe(true);
    // install restores into the custom library.
    await fsp.rm(store, { recursive: true, force: true });
    expect((await w.ok(["install", ...s, "--verbose"], { cwd: proj })).stdout).toContain("Installed repo://");
    await w.ok(["remove", "solo", "-p", "-y", ...s], { cwd: proj });
    await w.ok(["use", path.join(src, "a"), ...s, "--verbose"]);
    expect((await w.ok(["init", "made", ...s, "--verbose"], { cwd: proj })).stdout).toContain("Initialized skill: made");
    expect((await w.ok(["find", ...s, "--verbose"])).stdout).toContain("Usage: skill-library find");

    expect(await exists(w.store), "the default library").toBe(false);
    const idx = JSON.parse(await fsp.readFile(path.join(store, "index.json"), "utf8"));
    expect(idx.skills.map((r: any) => r.id)).toEqual([`repo://localhost${repo.bare.replace(/\.git$/, "")}/solo`]);
    await validateStore(w, store);
  });
});
