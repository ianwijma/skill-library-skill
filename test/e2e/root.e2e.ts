// The top level: banner, --version, global options, unknown commands and options (help: help.e2e.ts).
import { describe, expect, onTestFinished, test } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fakeTypeSafe } from "./fakes.ts";
import { e2e, exists, plain, skillMd, world } from "./harness.ts";
import { expectUnknownOption, expectUsageError } from "./contract.ts";
import { validateAll, validateGateway, validateStore } from "./validate.ts";

describe("sandbox guarantees", () => {
  test("runs in the e2e container, as a regular user", () => {
    expect(process.env.SKILL_LIBRARY_E2E_CONTAINER).toBe("1");
    expect(process.getuid?.()).not.toBe(0);
  });

  test("git can't push to any remote host, from the sandbox or the container's own config", async () => {
    const testWorld = await world();
    const repo = await testWorld.repo("local", { "a.txt": "a" });

    for (const remote of ["https://github.com/ianwijma/skill-library-skill.git", "git@github.com:ianwijma/skill-library-skill.git", "ssh://git@example.com/x.git"]) {
      // Through the sandbox's git config (what every CLI run uses)…
      expect(testWorld.git(repo.work, ["remote", "get-url", "--push", "origin"]).length).toBeGreaterThan(0);
      testWorld.git(repo.work, ["remote", "set-url", "origin", remote]);
      expect(testWorld.git(repo.work, ["remote", "get-url", "--push", "origin"])).toMatch(/^file:\/\/\/nonexistent\/e2e-push-blocked\//);
      // …and through the container user's own global config.
      const own = execFileSync("git", ["-C", repo.work, "remote", "get-url", "--push", "origin"], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: undefined } }).trim();

      expect(own).toMatch(/^file:\/\/\/nonexistent\/e2e-push-blocked\//);
    }
  });

  test("there is no network outside the container", async () => {
    await expect(fetch("https://github.com", { signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
  });
});

describe("root", () => {
  test("the installed binary is the packed package at this checkout's version", async () => {
    const testWorld = await world();

    for (const flag of ["--version", "-v"]) {
      const result = await testWorld.ok([flag]);

      expect(result.stdout).toBe(`${e2e().version}\n`);
      expect(result.stderr).toBe("");
    }

    // Global options are pulled out wherever they appear.
    expect((await testWorld.ok(["--verbose", "--version"])).stdout).toBe(`${e2e().version}\n`);
    expect((await testWorld.ok(["--store", path.join(testWorld.root, "x"), "-v"])).stdout).toBe(`${e2e().version}\n`);
  });

  test("no arguments prints the banner (no logo without a TTY) and exits 0", async () => {
    const testWorld = await world();
    const result = await testWorld.ok([]);
    const out = plain(result.stdout);

    for (const cmd of ["self setup", "add", "query", "use", "remove", "list", "find", "update", "install", "sync", "init"]) {
      expect(out).toContain(`skill-library ${cmd}`);
    }

    expect(out).toContain("try: skill-library add anthropics/skills");
    expect(out).not.toContain("┌─┐");
  });

  test("unknown command: a usage error naming it, nothing written; the old connect points at self setup", async () => {
    const testWorld = await world();

    for (const cmd of ["frobnicate", "lsit", "--frob", "-x"]) {
      expectUsageError(await testWorld.run([cmd]), cmd);
    }

    expect(await exists(testWorld.store)).toBe(false);
    const old = await testWorld.run(["connect"]);

    expect(old.code).toBe(1);
    expect(old.stderr).toContain("connect was replaced by self setup");
  });

  test("--store / --store= / SKILL_LIBRARY_DIR pick the library; --store without a value fails", async () => {
    const testWorld = await world();
    const src = await testWorld.write(await testWorld.dir("src"), { "a/SKILL.md": skillMd("a", "Skill A") });
    const viaFlag = path.join(testWorld.root, "lib-flag");
    const viaEq = path.join(testWorld.root, "lib-eq");
    const viaEnv = path.join(testWorld.root, "lib-env");

    await testWorld.ok(["add", path.join(src, "a"), "-g", "-y", "--store", viaFlag]);
    await testWorld.ok(["--store=" + viaEq, "add", path.join(src, "a"), "-g", "-y"]);
    await testWorld.ok(["add", path.join(src, "a"), "-g", "-y"], { env: { SKILL_LIBRARY_DIR: viaEnv } });

    for (const store of [viaFlag, viaEq, viaEnv]) {
      expect(await exists(path.join(store, "index.json")), store).toBe(true);
      const rows = (await testWorld.ok(["list", "-g", "--json", "--store", store])).json();

      expect(rows.map((row: any) => row.name)).toEqual(["a"]);
    }

    // The flag wins over the env var.
    const both = (await testWorld.ok(["list", "-g", "--json", "--store", path.join(testWorld.root, "empty")], { env: { SKILL_LIBRARY_DIR: viaEnv } })).json();

    expect(both).toEqual([]);
    expect(await exists(testWorld.store)).toBe(false);
    expectUsageError(await testWorld.run(["list", "--store"]), "--store");
  });

  test("unknown options are named (warned about or rejected); arguments after -- are positionals", async () => {
    const testWorld = await world();
    const result = await testWorld.run(["list", "-g", "--frobnicate", "--json"]);

    if (expectUnknownOption(result, "--frobnicate")) {
      expect(result.json()).toEqual([]);
    } else {
      expectUsageError(result, "--frobnicate");
    }

    const init = await testWorld.ok(["init", "--", "--weird"], { cwd: await testWorld.dir("p") });

    expect(init.stdout).toContain("Initialized skill: --weird");
    expect(await exists(path.join(testWorld.root, "p", "--weird", "SKILL.md"))).toBe(true);
  });

  test("smoke: add → list → the library validates and the gateway is placed in detected agents", async () => {
    const testWorld = await world();

    await testWorld.dir("home/.claude");
    const src = await testWorld.write(await testWorld.dir("src"), { "hello/SKILL.md": skillMd("hello", "Say hello nicely") });

    await testWorld.ok(["add", path.join(src, "hello"), "-g", "-y"]);
    const index = await validateAll(testWorld);

    expect(index.skills.map((skill) => skill.id)).toEqual([`path://${path.join(src, "hello")}`]);
    await validateGateway([path.join(testWorld.home, ".claude", "skills")]);
  });

  test("--store (anywhere on the line) and --verbose work with every command; the default library is never touched", async () => {
    const testWorld = await world();
    const store = path.join(testWorld.root, "custom-lib");
    const storeArgs = ["--store", store];
    const src = await testWorld.write(await testWorld.dir("src"), {
      "a/SKILL.md": skillMd("a", "Skill A"),
      "b/SKILL.md": skillMd("b", "Always on", "", "metadata:\n  always: true\n"),
    });
    const repo = await testWorld.repo("solo", { "SKILL.md": skillMd("solo", "Solo skill") });
    const proj = await testWorld.dir("proj");

    await testWorld.ok([...storeArgs, "add", path.join(src, "a"), "-g", "-y", "--verbose"]);
    await testWorld.ok(["add", "--verbose", path.join(src, "b"), "-g", "-y", ...storeArgs]);
    await testWorld.ok(["a", repo.url, "-p", "-y", `--store=${store}`], { cwd: proj });
    // --json output stays one JSON value with --verbose anywhere.
    const rows = (await testWorld.ok(["--verbose", "list", "-g", "--json", ...storeArgs])).json();

    expect(rows.map((row: any) => row.name).sort()).toEqual(["a", "b", "solo"]);
    expect((await testWorld.ok(["ls", "--json", ...storeArgs, "--verbose"], { cwd: proj })).json().map((row: any) => row.name)).toEqual(["solo"]);
    expect((await testWorld.ok(["check", ...storeArgs, "--verbose"], { cwd: proj })).stdout).toContain("All skills are up to date.");
    expect((await testWorld.ok(["update", "-g", ...storeArgs])).stdout).toMatch(/up to date|Skipped/);
    // query scores the custom library (and prints model/usage on stderr with --verbose).
    const ts = await fakeTypeSafe();

    onTestFinished(() => ts.close());
    const qr = await testWorld.ok(["query", "anything about skill", "--json", ...storeArgs, "--verbose"], { env: { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url, SKILL_LIBRARY_TYPESAFE_API_KEY: "k" } });

    expect(qr.stderr).toContain("verbose:");
    expect(ts.lastAsked()).toEqual(["a", "find-skills"]); // solo is project-only; b is always-on
    const queryOutput = qr.json();

    expect(queryOutput.matches.map((match: any) => match.name)).toContain("b");
    expect(queryOutput.matches.find((match: any) => match.name === "b").path.startsWith(store)).toBe(true);
    // install restores into the custom library.
    await fsp.rm(store, { recursive: true, force: true });
    expect((await testWorld.ok(["install", ...storeArgs, "--verbose"], { cwd: proj })).stdout).toContain("Installed repo://");
    await testWorld.ok(["remove", "solo", "-p", "-y", ...storeArgs], { cwd: proj });
    await testWorld.ok(["use", path.join(src, "a"), ...storeArgs, "--verbose"]);
    expect((await testWorld.ok(["init", "made", ...storeArgs, "--verbose"], { cwd: proj })).stdout).toContain("Initialized skill: made");
    expect((await testWorld.ok(["find", ...storeArgs, "--verbose"])).stdout).toMatch(/skill-library find/);

    expect(await exists(testWorld.store), "the default library").toBe(false);
    const idx = JSON.parse(await fsp.readFile(path.join(store, "index.json"), "utf8"));

    expect(idx.skills.map((skill: any) => skill.id)).toEqual([`repo://localhost${repo.bare.replace(/\.git$/, "")}/solo`]);
    await validateStore(testWorld, store);
  });
});
