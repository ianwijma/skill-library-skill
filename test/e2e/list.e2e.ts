// `list` (alias `ls`): project skills when a skill-library.json exists, else the whole library.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { skillMd, world } from "./harness.ts";
import { expectJsonOrNothing, expectUsageError } from "./contract.ts";
import { assertListJson, validateAll } from "./validate.ts";

describe("list", () => {
  test("empty library and empty project: both scopes say so, --json is []", async () => {
    const w = await world();
    for (const cmd of ["list", "ls"]) {
      const r = await w.ok([cmd]);
      expect(r.stdout).toBe("No global skills found.\nTry listing project skills without -g\n");
      expect((await w.ok([cmd, "--json"])).json()).toEqual([]);
      expect((await w.ok([cmd, "-g", "--json"])).json()).toEqual([]);
    }
    const proj = await w.dir("proj");
    await fsp.writeFile(path.join(proj, "skill-library.json"), '{"version":1,"skills":{}}\n');
    const r = await w.ok(["list"], { cwd: proj });
    expect(r.stdout).toBe("No project skills found.\nTry listing global skills with -g\n");
    expect((await w.ok(["ls", "-g"], { cwd: proj })).stdout).toContain("No global skills found.");
    expect((await w.ok(["ls", "--json"], { cwd: proj })).json()).toEqual([]);
  });

  test("global: sorted by name, text and --json agree; -a filters by agent", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), {
      "zeta/SKILL.md": skillMd("zeta", "Zeta skill"),
      "alpha/SKILL.md": skillMd("alpha", "Alpha skill"),
      "mid/SKILL.md": skillMd("mid", "Mid skill"),
    });
    const gh = await w.github("acme/tools", { "SKILL.md": skillMd("gitty", "Git hosted") });
    await w.ok(["add", path.join(src, "zeta"), "-g", "-y", "-a", "codex"]);
    await w.ok(["add", path.join(src, "alpha"), "-g", "-y", "-a", "claude-code"]);
    await w.ok(["add", path.join(src, "mid"), "-g", "-y"]);
    await w.ok(["add", "acme/tools", "-g", "-y", "-a", "codex", "claude-code"]);
    await validateAll(w);

    const rows = (await w.ok(["list", "--json"])).json();
    assertListJson(rows);
    expect(rows.map((r) => r.name)).toEqual(["alpha", "gitty", "mid", "zeta"]);
    expect(rows.every((r) => r.scope === "global" && r.status === "tracked")).toBe(true);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.zeta).toMatchObject({ agents: ["Codex"], sourceType: "local", sourceUrl: null, id: `path://${path.join(src, "zeta")}`, source: path.join(src, "zeta") });
    expect(byName.gitty).toMatchObject({ agents: ["Codex", "Claude Code"], sourceType: "git", sourceUrl: gh.url, source: gh.url, id: "repo://github.com/acme/tools/gitty" });
    expect(byName.mid.agents.length).toBeGreaterThan(10); // all agents, as display names
    for (const r of rows) expect(r.path.startsWith(w.store)).toBe(true);

    const text = (await w.ok(["ls"])).stdout;
    expect(text.startsWith("Global Skills\n")).toBe(true);
    const names = text.split("\n").filter((l) => /^\S/.test(l) && l !== "Global Skills").map((l) => l.split(/\s+/)[0]);
    expect(names).toEqual(["alpha", "gitty", "mid", "zeta"]);
    expect(text).toContain("Agents: Codex  Source: " + path.join(src, "zeta"));
    expect(text).toContain("Agents: all agents  Source: " + path.join(src, "mid"));
    expect(text).toContain("Agents: Codex, Claude Code  Source: " + gh.url);
    // Library paths are shown relative to the working folder when inside it, else to ~.
    expect(text).toContain("./home/.local/share/skill-library/skills/");
    expect((await w.ok(["ls"], { cwd: await w.dir("elsewhere") })).stdout).toContain("~/.local/share/skill-library/skills/");

    const names1 = (await w.ok(["list", "-a", "codex", "--json"])).json().map((r: any) => r.name);
    expect(names1).toEqual(["gitty", "mid", "zeta"]);
    const names2 = (await w.ok(["list", "--agent", "claude-code", "--json"])).json().map((r: any) => r.name);
    expect(names2).toEqual(["alpha", "gitty", "mid"]);
    const both = (await w.ok(["list", "-a", "codex", "claude-code", "--json"])).json().map((r: any) => r.name);
    expect(both).toEqual(["alpha", "gitty", "mid", "zeta"]);
    const cursor = (await w.ok(["list", "-a", "cursor", "--json"])).json().map((r: any) => r.name);
    expect(cursor).toEqual(["mid"]);
    expect((await w.ok(["ls", "-a", "cursor"])).stdout).not.toContain("zeta");
  });

  test("invalid agents: vercel's diagnostic on stdout (exit 1); --json keeps stdout to []", async () => {
    const w = await world();
    const r = await w.run(["list", "-a", "nope", "codex", "bogus"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^Invalid agents: nope, bogus\nValid agents: .*claude-code.*codex/);
    const star = await w.run(["ls", "-a", "*"]);
    expect(star.code).toBe(1);
    expect(star.stdout).toContain("Invalid agents: *");
    const j = await w.run(["list", "-a", "nope", "--json"]);
    expect(j.code).toBe(1);
    expect(j.stdout).toBe("[]\n");
    expect(j.stderr).toContain("Invalid agents: nope");
    expectUsageError(await w.run(["list", "-a"]), "-a", "--agent"); // see below
  });

  test("project: only with a skill-library.json; statuses tracked/untracked/missing; -g lists the library", async () => {
    const a = await world();
    const proj = await a.dir("proj");
    const src = await a.write(await a.dir("src"), { "glob/SKILL.md": skillMd("glob", "Global only"), "pinned/SKILL.md": skillMd("pinned", "Pinned in project") });
    const repo = await a.repo("r", { "SKILL.md": skillMd("remote", "Remote skill") });
    await a.write(proj, { "skills/here/SKILL.md": skillMd("here", "In this repository") });

    // Without a manifest the folder is not a project: list shows the library.
    await a.ok(["add", path.join(src, "glob"), "-g", "-y"], { cwd: proj });
    expect((await a.ok(["list", "--json"], { cwd: proj })).json()).toMatchObject([{ name: "glob", scope: "global", status: "tracked" }]);

    await a.ok(["add", "-p", path.join(src, "pinned"), "-y", "-a", "codex"], { cwd: proj });
    await a.ok(["add", "-p", repo.url, "-y"], { cwd: proj });
    await a.ok(["add", "-p", "./skills/here", "-y"], { cwd: proj });
    await validateAll(a, [proj]);

    const rows = (await a.ok(["list", "--json"], { cwd: proj })).json();
    assertListJson(rows);
    expect(rows.map((r) => [r.name, r.scope, r.status])).toEqual([
      ["here", "project", "tracked"],
      ["pinned", "project", "tracked"],
      ["remote", "project", "tracked"],
    ]);
    const here = rows.find((r) => r.name === "here");
    expect(here).toMatchObject({ id: "local://skills/here", path: path.join(proj, "skills", "here") });
    expect(rows.find((r) => r.name === "pinned").agents).toEqual(["Codex"]);
    const text = (await a.ok(["ls"], { cwd: proj })).stdout;
    expect(text.startsWith("Project Skills\n")).toBe(true);
    expect(text).toContain("./skills/here"); // paths in the project are shown relative to it
    expect(text).not.toContain("glob");

    // A nested folder finds the ancestor's manifest.
    const nested = await a.dir("proj/a/b");
    expect((await a.ok(["list", "--json"], { cwd: nested })).json().map((r: any) => r.name)).toEqual(["here", "pinned", "remote"]);

    // -g: the whole library; project-only skills are untracked (not global), local:// never stored.
    const g = (await a.ok(["list", "-g", "--json"], { cwd: proj })).json();
    assertListJson(g);
    expect(g.map((r) => [r.name, r.status])).toEqual([
      ["glob", "tracked"],
      ["pinned", "untracked"],
      ["remote", "untracked"],
    ]);
    expect(g.find((r) => r.name === "pinned").agents).toEqual([]);
    const gText = (await a.ok(["list", "-g"], { cwd: proj })).stdout;
    expect(gText).toMatch(/pinned .* \(not global\)/);
    expect(gText).not.toMatch(/glob .* \(not global\)/);

    // On a fresh machine the git and folder skills are missing until install.
    const b = await a.machine("b");
    const missing = (await b.ok(["list", "--json"], { cwd: proj })).json();
    assertListJson(missing);
    expect(missing.map((r) => [r.name, r.status, r.path])).toEqual([
      ["here", "tracked", path.join(proj, "skills", "here")],
      ["pinned", "missing", null],
      ["remote", "missing", null],
    ]);
    const mText = (await b.ok(["ls"], { cwd: proj })).stdout;
    expect(mText).toContain("Missing (in skill-library.json, not installed — run skill-library install)");
    expect(mText).toMatch(/Missing[^\n]*\n {2}pinned {2}Source: /);
    await b.ok(["install"], { cwd: proj });
    expect((await b.ok(["list", "--json"], { cwd: proj })).json().every((r: any) => r.status === "tracked")).toBe(true);
    await validateAll(b, [proj]);
  });

  test("$HOME is never a project, even with a skill-library.json in it", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), { "g/SKILL.md": skillMd("g", "Global") });
    await w.ok(["add", path.join(src, "g"), "-g", "-y"]);
    await fsp.writeFile(path.join(w.home, "skill-library.json"), '{"version":1,"skills":{}}\n');
    const sub = path.join(w.home, "code", "thing");
    await fsp.mkdir(sub, { recursive: true });
    for (const cwd of [w.home, sub]) {
      const rows = (await w.ok(["list", "--json"], { cwd })).json();
      expect(rows.map((r: any) => [r.name, r.scope])).toEqual([["g", "global"]]);
      expect((await w.ok(["ls"], { cwd })).stdout.startsWith("Global Skills")).toBe(true);
    }
  });

  test("a corrupted index.json exits 2; --json still prints one JSON value", async () => {
    const w = await world();
    await w.write(w.store, { "index.json": "{oops" });
    for (const content of ["{oops", "[]", '{"version":2,"skills":[]}', '{"version":1,"skills":[{"id":1}]}']) {
      await fsp.writeFile(path.join(w.store, "index.json"), content);
      const r = await w.run(["list"]);
      expect(r.code, content).toBe(2);
      expect(r.stderr).toContain("index.json is corrupted");
      expect(r.stdout).toBe("");
      const j = await w.run(["ls", "-g", "--json"]);
      expect(j.code).toBe(2);
      expect(j.stdout).toBe("[]\n");
      expect(j.stderr).toContain("index.json is corrupted");
    }
  });

  test("long and inline forms: --global and --agent / --agent=a,b match -g and -a", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), { "any/SKILL.md": skillMd("any", "Any agent"), "cx/SKILL.md": skillMd("cx", "Codex only"), "cl/SKILL.md": skillMd("cl", "Claude only") });
    await w.ok(["add", path.join(src, "any"), "-g", "-y"]);
    await w.ok(["add", path.join(src, "cx"), "-g", "-y", "-a", "codex"]);
    await w.ok(["add", path.join(src, "cl"), "-g", "-y", "-a", "claude-code"]);
    await validateAll(w);
    const names = async (args: string[]) => {
      const rows = (await w.ok(["list", ...args, "--json"], { cwd: w.home })).json();
      assertListJson(rows);
      return rows.map((r: any) => r.name);
    };
    const proj = await w.dir("proj");
    await fsp.writeFile(path.join(proj, "skill-library.json"), '{"version":1,"skills":{}}\n');
    expect((await w.ok(["list", "--global", "--json"], { cwd: proj })).json()).toEqual((await w.ok(["list", "-g", "--json"], { cwd: proj })).json());
    expect((await w.ok(["list", "--global", "--json"], { cwd: proj })).json().map((r: any) => r.name)).toEqual(["any", "cl", "cx"]);
    expect(await names(["--agent", "codex"])).toEqual(await names(["-a", "codex"]));
    expect(await names(["--agent", "codex"])).toEqual(["any", "cx"]);
    expect(await names(["--agent=codex,claude-code"])).toEqual(["any", "cl", "cx"]);
    expect(await names(["--agent=cursor"])).toEqual(["any"]);
  });

  test("a missing -a / --agent value is a usage error, like add and query", async () => {
    const w = await world();
    for (const args of [["list", "-a"], ["list", "--agent"], ["list", "--agent="], ["list", "-g", "-a", "--json"]]) {
      const r = await w.run(args);
      expectUsageError(r, "-a", "--agent");
      expectJsonOrNothing(r);
    }
  });
});
