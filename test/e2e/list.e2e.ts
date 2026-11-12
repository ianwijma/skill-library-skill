// `list` (alias `ls`): project skills when a skill-library.json exists, else the whole library.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { skillMd, world } from "./harness.ts";
import { expectJsonOrNothing, expectUsageError } from "./contract.ts";
import { assertListJson, validateAll } from "./validate.ts";

describe("list", () => {
  test("empty library and empty project: both scopes say so, --json is []", async () => {
    const testWorld = await world();

    for (const cmd of ["list", "ls"]) {
      const result = await testWorld.ok([cmd]);

      expect(result.stdout).toBe("No global skills found.\nTry listing project skills without -g\n");
      expect((await testWorld.ok([cmd, "--json"])).json()).toEqual([]);
      expect((await testWorld.ok([cmd, "-g", "--json"])).json()).toEqual([]);
    }

    const proj = await testWorld.dir("proj");

    await fsp.writeFile(path.join(proj, "skill-library.json"), '{"version":1,"skills":{}}\n');
    const result = await testWorld.ok(["list"], { cwd: proj });

    expect(result.stdout).toBe("No project skills found.\nTry listing global skills with -g\n");
    expect((await testWorld.ok(["ls", "-g"], { cwd: proj })).stdout).toContain("No global skills found.");
    expect((await testWorld.ok(["ls", "--json"], { cwd: proj })).json()).toEqual([]);
  });

  test("global: sorted by name, text and --json agree; -a filters by agent", async () => {
    const testWorld = await world();
    const src = await testWorld.write(await testWorld.dir("src"), {
      "zeta/SKILL.md": skillMd("zeta", "Zeta skill"),
      "alpha/SKILL.md": skillMd("alpha", "Alpha skill"),
      "mid/SKILL.md": skillMd("mid", "Mid skill"),
    });
    const gh = await testWorld.github("acme/tools", { "SKILL.md": skillMd("gitty", "Git hosted") });

    await testWorld.ok(["add", path.join(src, "zeta"), "-g", "-y", "-a", "codex"]);
    await testWorld.ok(["add", path.join(src, "alpha"), "-g", "-y", "-a", "claude-code"]);
    await testWorld.ok(["add", path.join(src, "mid"), "-g", "-y"]);
    await testWorld.ok(["add", "acme/tools", "-g", "-y", "-a", "codex", "claude-code"]);
    await validateAll(testWorld);

    const rows = (await testWorld.ok(["list", "--json"])).json();

    assertListJson(rows);
    expect(rows.map((row) => row.name)).toEqual(["alpha", "gitty", "mid", "zeta"]);
    expect(rows.every((row) => row.scope === "global" && row.status === "tracked")).toBe(true);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

    expect(byName.zeta).toMatchObject({ agents: ["Codex"], sourceType: "local", sourceUrl: null, id: `path://${path.join(src, "zeta")}`, source: path.join(src, "zeta") });
    expect(byName.gitty).toMatchObject({ agents: ["Codex", "Claude Code"], sourceType: "git", sourceUrl: gh.url, source: gh.url, id: "repo://github.com/acme/tools/gitty" });
    expect(byName.mid.agents.length).toBeGreaterThan(10); // all agents, as display names

    for (const result of rows) {
      expect(result.path.startsWith(testWorld.store)).toBe(true);
    }

    const text = (await testWorld.ok(["ls"])).stdout;

    expect(text.startsWith("Global Skills\n")).toBe(true);
    const names = text.split("\n").filter((line) => /^\S/.test(line) && line !== "Global Skills").map((line) => line.split(/\s+/)[0]);

    expect(names).toEqual(["alpha", "gitty", "mid", "zeta"]);
    expect(text).toContain("Agents: Codex  Source: " + path.join(src, "zeta"));
    expect(text).toContain("Agents: all agents  Source: " + path.join(src, "mid"));
    expect(text).toContain("Agents: Codex, Claude Code  Source: " + gh.url);
    // Library paths are shown relative to the working folder when inside it, else to ~.
    expect(text).toContain("./home/.local/share/skill-library/skills/");
    expect((await testWorld.ok(["ls"], { cwd: await testWorld.dir("elsewhere") })).stdout).toContain("~/.local/share/skill-library/skills/");

    const names1 = (await testWorld.ok(["list", "-a", "codex", "--json"])).json().map((row: any) => row.name);

    expect(names1).toEqual(["gitty", "mid", "zeta"]);
    const names2 = (await testWorld.ok(["list", "--agent", "claude-code", "--json"])).json().map((row: any) => row.name);

    expect(names2).toEqual(["alpha", "gitty", "mid"]);
    const both = (await testWorld.ok(["list", "-a", "codex", "claude-code", "--json"])).json().map((row: any) => row.name);

    expect(both).toEqual(["alpha", "gitty", "mid", "zeta"]);
    const cursor = (await testWorld.ok(["list", "-a", "cursor", "--json"])).json().map((row: any) => row.name);

    expect(cursor).toEqual(["mid"]);
    expect((await testWorld.ok(["ls", "-a", "cursor"])).stdout).not.toContain("zeta");
  });

  test("invalid agents: vercel's diagnostic on stdout (exit 1); --json keeps stdout to []", async () => {
    const testWorld = await world();
    const result = await testWorld.run(["list", "-a", "nope", "codex", "bogus"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^Invalid agents: nope, bogus\nValid agents: .*claude-code.*codex/);
    const star = await testWorld.run(["ls", "-a", "*"]);

    expect(star.code).toBe(1);
    expect(star.stdout).toContain("Invalid agents: *");
    const jsonRun = await testWorld.run(["list", "-a", "nope", "--json"]);

    expect(jsonRun.code).toBe(1);
    expect(jsonRun.stdout).toBe("[]\n");
    expect(jsonRun.stderr).toContain("Invalid agents: nope");
    expectUsageError(await testWorld.run(["list", "-a"]), "-a", "--agent"); // see below
  });

  test("project: only with a skill-library.json; statuses tracked/untracked/missing; -g lists the library", async () => {
    const machineA = await world();
    const proj = await machineA.dir("proj");
    const src = await machineA.write(await machineA.dir("src"), { "glob/SKILL.md": skillMd("glob", "Global only"), "pinned/SKILL.md": skillMd("pinned", "Pinned in project") });
    const repo = await machineA.repo("r", { "SKILL.md": skillMd("remote", "Remote skill") });

    await machineA.write(proj, { "skills/here/SKILL.md": skillMd("here", "In this repository") });

    // Without a manifest the folder is not a project: list shows the library.
    await machineA.ok(["add", path.join(src, "glob"), "-g", "-y"], { cwd: proj });
    expect((await machineA.ok(["list", "--json"], { cwd: proj })).json()).toMatchObject([{ name: "glob", scope: "global", status: "tracked" }]);

    await machineA.ok(["add", "-p", path.join(src, "pinned"), "-y", "-a", "codex"], { cwd: proj });
    await machineA.ok(["add", "-p", repo.url, "-y"], { cwd: proj });
    await machineA.ok(["add", "-p", "./skills/here", "-y"], { cwd: proj });
    await validateAll(machineA, [proj]);

    const rows = (await machineA.ok(["list", "--json"], { cwd: proj })).json();

    assertListJson(rows);
    expect(rows.map((row) => [row.name, row.scope, row.status])).toEqual([
      ["here", "project", "tracked"],
      ["pinned", "project", "tracked"],
      ["remote", "project", "tracked"],
    ]);
    const here = rows.find((row) => row.name === "here");

    expect(here).toMatchObject({ id: "local://skills/here", path: path.join(proj, "skills", "here") });
    expect(rows.find((row) => row.name === "pinned").agents).toEqual(["Codex"]);
    const text = (await machineA.ok(["ls"], { cwd: proj })).stdout;

    expect(text.startsWith("Project Skills\n")).toBe(true);
    expect(text).toContain("./skills/here"); // paths in the project are shown relative to it
    expect(text).not.toContain("glob");

    // A nested folder finds the ancestor's manifest.
    const nested = await machineA.dir("proj/a/b");

    expect((await machineA.ok(["list", "--json"], { cwd: nested })).json().map((row: any) => row.name)).toEqual(["here", "pinned", "remote"]);

    // -g: the whole library; project-only skills are untracked (not global), local:// never stored.
    const globalRows = (await machineA.ok(["list", "-g", "--json"], { cwd: proj })).json();

    assertListJson(globalRows);
    expect(globalRows.map((row) => [row.name, row.status])).toEqual([
      ["glob", "tracked"],
      ["pinned", "untracked"],
      ["remote", "untracked"],
    ]);
    expect(globalRows.find((row) => row.name === "pinned").agents).toEqual([]);
    const gText = (await machineA.ok(["list", "-g"], { cwd: proj })).stdout;

    expect(gText).toMatch(/pinned .* \(not global\)/);
    expect(gText).not.toMatch(/glob .* \(not global\)/);

    // On a fresh machine the git and folder skills are missing until install.
    const machineB = await machineA.machine("b");
    const missing = (await machineB.ok(["list", "--json"], { cwd: proj })).json();

    assertListJson(missing);
    expect(missing.map((row) => [row.name, row.status, row.path])).toEqual([
      ["here", "tracked", path.join(proj, "skills", "here")],
      ["pinned", "missing", null],
      ["remote", "missing", null],
    ]);
    const mText = (await machineB.ok(["ls"], { cwd: proj })).stdout;

    expect(mText).toContain("Missing (in skill-library.json, not installed — run skill-library install)");
    expect(mText).toMatch(/Missing[^\n]*\n {2}pinned {2}Source: /);
    await machineB.ok(["install"], { cwd: proj });
    expect((await machineB.ok(["list", "--json"], { cwd: proj })).json().every((row: any) => row.status === "tracked")).toBe(true);
    await validateAll(machineB, [proj]);
  });

  test("$HOME is never a project, even with a skill-library.json in it", async () => {
    const testWorld = await world();
    const src = await testWorld.write(await testWorld.dir("src"), { "g/SKILL.md": skillMd("g", "Global") });

    await testWorld.ok(["add", path.join(src, "g"), "-g", "-y"]);
    await fsp.writeFile(path.join(testWorld.home, "skill-library.json"), '{"version":1,"skills":{}}\n');
    const sub = path.join(testWorld.home, "code", "thing");

    await fsp.mkdir(sub, { recursive: true });

    for (const cwd of [testWorld.home, sub]) {
      const rows = (await testWorld.ok(["list", "--json"], { cwd })).json();

      expect(rows.map((row: any) => [row.name, row.scope])).toEqual([["g", "global"]]);
      expect((await testWorld.ok(["ls"], { cwd })).stdout.startsWith("Global Skills")).toBe(true);
    }
  });

  test("a corrupted index.json exits 2; --json still prints one JSON value", async () => {
    const testWorld = await world();

    await testWorld.write(testWorld.store, { "index.json": "{oops" });

    for (const content of ["{oops", "[]", '{"version":2,"skills":[]}', '{"version":1,"skills":[{"id":1}]}']) {
      await fsp.writeFile(path.join(testWorld.store, "index.json"), content);
      const result = await testWorld.run(["list"]);

      expect(result.code, content).toBe(2);
      expect(result.stderr).toContain("index.json is corrupted");
      expect(result.stdout).toBe("");
      const jsonRun = await testWorld.run(["ls", "-g", "--json"]);

      expect(jsonRun.code).toBe(2);
      expect(jsonRun.stdout).toBe("[]\n");
      expect(jsonRun.stderr).toContain("index.json is corrupted");
    }
  });

  test("long and inline forms: --global and --agent / --agent=a,b match -g and -a", async () => {
    const testWorld = await world();
    const src = await testWorld.write(await testWorld.dir("src"), { "any/SKILL.md": skillMd("any", "Any agent"), "cx/SKILL.md": skillMd("cx", "Codex only"), "cl/SKILL.md": skillMd("cl", "Claude only") });

    await testWorld.ok(["add", path.join(src, "any"), "-g", "-y"]);
    await testWorld.ok(["add", path.join(src, "cx"), "-g", "-y", "-a", "codex"]);
    await testWorld.ok(["add", path.join(src, "cl"), "-g", "-y", "-a", "claude-code"]);
    await validateAll(testWorld);

    const names = async (args: string[]) => {
      const rows = (await testWorld.ok(["list", ...args, "--json"], { cwd: testWorld.home })).json();

      assertListJson(rows);

      return rows.map((row: any) => row.name);
    };

    const proj = await testWorld.dir("proj");

    await fsp.writeFile(path.join(proj, "skill-library.json"), '{"version":1,"skills":{}}\n');
    expect((await testWorld.ok(["list", "--global", "--json"], { cwd: proj })).json()).toEqual((await testWorld.ok(["list", "-g", "--json"], { cwd: proj })).json());
    expect((await testWorld.ok(["list", "--global", "--json"], { cwd: proj })).json().map((row: any) => row.name)).toEqual(["any", "cl", "cx"]);
    expect(await names(["--agent", "codex"])).toEqual(await names(["-a", "codex"]));
    expect(await names(["--agent", "codex"])).toEqual(["any", "cx"]);
    expect(await names(["--agent=codex,claude-code"])).toEqual(["any", "cl", "cx"]);
    expect(await names(["--agent=cursor"])).toEqual(["any"]);
  });

  test("a missing -a / --agent value is a usage error, like add and query", async () => {
    const testWorld = await world();

    for (const args of [["list", "-a"], ["list", "--agent"], ["list", "--agent="], ["list", "-g", "-a", "--json"]]) {
      const result = await testWorld.run(args);

      expectUsageError(result, "-a", "--agent");
      expectJsonOrNothing(result);
    }
  });
});
