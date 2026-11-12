// `remove` (aliases `rm`, `r`): global deletes from the library; -p drops the project's reference.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { exists, readJson, skillMd, world, type World } from "./harness.ts";
import { expectUsageError } from "./contract.ts";
import { validateAll, type Manifest, type StoreIndex } from "./validate.ts";

async function index(w: World): Promise<StoreIndex> {
  return readJson<StoreIndex>(path.join(w.store, "index.json"));
}

async function names(w: World): Promise<string[]> {
  return (await index(w)).skills.map((s) => s.versions[s.current]!.name).sort();
}

/** A library with three global folder skills: alpha, beta (codex + claude-code), gamma (codex only). */
async function seeded(): Promise<{ w: World; src: string }> {
  const w = await world();
  const src = await w.write(await w.dir("src"), {
    "alpha/SKILL.md": skillMd("alpha", "Alpha skill"),
    "beta/SKILL.md": skillMd("beta", "Beta skill"),
    "gamma/SKILL.md": skillMd("gamma", "Gamma skill"),
  });
  await w.ok(["add", path.join(src, "alpha"), "-g", "-y"]);
  await w.ok(["add", path.join(src, "beta"), "-g", "-y", "-a", "codex", "claude-code"]);
  await w.ok(["add", path.join(src, "gamma"), "-g", "-y", "-a", "codex"]);
  await validateAll(w);
  return { w, src };
}

describe("remove", () => {
  test("global: by name, -s/--skill and full id, under every alias; folders are deleted", async () => {
    const { w, src } = await seeded();
    const alphaDir = path.join(w.store, (await index(w)).skills.find((s) => s.id.endsWith("/alpha"))!.dir);
    expect(await exists(alphaDir)).toBe(true);

    const r = await w.ok(["remove", "alpha", "-y"]);
    expect(r.stdout).toContain(`✓ Removed alpha (path://${path.join(src, "alpha")})`);
    expect(r.stdout).toContain("Successfully removed 1 skill(s)");
    expect(r.stdout).toContain("Done!");
    expect(await exists(alphaDir)).toBe(false);
    expect(await names(w)).toEqual(["beta", "gamma"]);
    await validateAll(w);

    await w.ok(["rm", "-g", "-s", "beta", "-y"]);
    expect(await names(w)).toEqual(["gamma"]);
    await validateAll(w);

    await w.ok(["r", "--global", "--skill", `path://${path.join(src, "gamma")}`, "--yes"]);
    expect(await names(w)).toEqual([]);
    // Removing the last skill leaves a valid, empty library.
    const idx = await validateAll(w);
    expect(idx.skills).toEqual([]);
    expect(await fsp.readdir(path.join(w.store, "skills"))).toEqual([]);
    expect((await w.ok(["list", "-g"])).stdout).toContain("No global skills found.");
  });

  test("several names at once (positionals + -s), and unmatched names exit 0", async () => {
    const { w } = await seeded();
    const r = await w.ok(["remove", "alpha", "nope", "-s", "gamma", "-y"]);
    expect(r.stdout).toContain("✓ Removed alpha");
    expect(r.stdout).toContain("✓ Removed gamma");
    expect(r.stdout).toContain("Successfully removed 2 skill(s)");
    expect(await names(w)).toEqual(["beta"]);
    await validateAll(w);

    const none = await w.ok(["remove", "nope", "nada", "-y"]);
    expect(none.stdout).toBe("No matching skills found for: nope, nada\n");
    expect(await names(w)).toEqual(["beta"]);
  });

  test("-a removes agents from a skill's list; the last agent removes the skill; all-agents skills explain", async () => {
    const { w } = await seeded();
    const agentsOf = async (n: string) => (await index(w)).skills.find((s) => s.versions[s.current]!.name === n)?.agents;

    const one = await w.ok(["remove", "beta", "-a", "codex", "-y"]);
    expect(one.stdout).toContain("✓ Updated agents for beta");
    expect(await agentsOf("beta")).toEqual(["claude-code"]);
    await validateAll(w);
    // Agents not on the list change nothing but still count as handled.
    await w.ok(["remove", "beta", "--agent", "cursor", "-y"]);
    expect(await agentsOf("beta")).toEqual(["claude-code"]);

    const last = await w.ok(["remove", "gamma", "-a", "codex", "-y"]);
    expect(last.stdout).toContain("✓ Removed gamma");
    expect(await agentsOf("gamma")).toBeUndefined();
    await validateAll(w);

    const all = await w.ok(["remove", "alpha", "-a", "codex", "-y"]);
    expect(all.stdout).toContain("! alpha is available to all agents; remove it without -a");
    expect(all.stdout).not.toContain("Successfully removed");
    expect(await agentsOf("alpha")).toBe("all");

    // -a '*' removes the skill entirely.
    await w.ok(["remove", "alpha", "-a", "*", "-y"]);
    expect(await names(w)).toEqual(["beta"]);

    const bad = await w.run(["remove", "beta", "-a", "nope", "-y"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Invalid agents: nope");
    expect(await names(w)).toEqual(["beta"]);
    await validateAll(w);
  });

  test("--all empties the scope; --all with names is an error", async () => {
    const { w } = await seeded();
    const both = await w.run(["remove", "--all", "alpha"]);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("Cannot combine --all with specific skill names.");
    expect(both.stderr).toContain("skill-library remove alpha -y");
    expect(await names(w)).toEqual(["alpha", "beta", "gamma"]);

    // --all needs no -y; '*' as a name works the same.
    const all = await w.ok(["remove", "--all"]);
    expect(all.stdout).toContain("Successfully removed 3 skill(s)");
    expect(await names(w)).toEqual([]);
    await validateAll(w);
    const again = await w.ok(["remove", "--all"]);
    expect(again.stdout).toBe("Done!\n");
  });

  test("'*' selects everything in scope", async () => {
    const { w } = await seeded();
    await w.ok(["remove", "*", "-y"]);
    expect(await names(w)).toEqual([]);
    await validateAll(w);
  });

  test("without a TTY and without -y nothing is removed; inside an agent -y is implied", async () => {
    const { w } = await seeded();
    const noYes = await w.run(["remove", "alpha"]);
    expect(noYes.code).toBe(1);
    expect(noYes.stderr).toContain("Interactive prompt required but stdin is not a TTY. Nothing was removed. Use -y to run non-interactively.");
    const noNames = await w.run(["remove"]);
    expect(noNames.code).toBe(1);
    expect(noNames.stderr).toContain("Name the skills to remove (or use --all)");
    const noNamesYes = await w.run(["rm", "-y"]);
    expect(noNamesYes.code).toBe(1);
    expect(await names(w)).toEqual(["alpha", "beta", "gamma"]);

    for (const env of [{ CLAUDECODE: "1" }, { CODEX_SANDBOX: "seatbelt" }, { AI_AGENT: "x" }]) expect((await w.run(["remove", "nope"], { env })).code).toBe(0);
    await w.ok(["remove", "alpha"], { env: { CLAUDECODE: "1" } });
    expect(await names(w)).toEqual(["beta", "gamma"]);
    await validateAll(w);
  });

  test("a name matching two skills fails and deletes nothing; the id picks one", async () => {
    const w = await world();
    const one = await w.write(await w.dir("one"), { "react/SKILL.md": skillMd("react", "React one") });
    const two = await w.write(await w.dir("two"), { "react/SKILL.md": skillMd("react", "React two") });
    await w.ok(["add", path.join(one, "react"), "-g", "-y"]);
    // A second global skill with the same name replaces the first (kept in the store, not global).
    await w.ok(["add", path.join(two, "react"), "-g", "-y"]);
    expect((await index(w)).skills).toHaveLength(2);
    const r = await w.run(["remove", "react", "-y"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('"react" matches several skills:');
    expect(r.stderr).toContain(`  - path://${path.join(one, "react")}`);
    expect(r.stderr).toContain(`  - path://${path.join(two, "react")}`);
    expect(r.stderr).toContain("Pass the full id to pick one.");
    expect((await index(w)).skills).toHaveLength(2);
    await w.ok(["remove", `path://${path.join(one, "react")}`, "-y"]);
    expect((await index(w)).skills.map((s) => s.id)).toEqual([`path://${path.join(two, "react")}`]);
    await validateAll(w);
  });

  test("the built-in find-skills can't be removed", async () => {
    const w = await world();
    const r = await w.ok(["remove", "find-skills", "-y"]);
    expect(r.stderr).toContain("find-skills is built into skill-library: it can't be removed or updated on its own");
    expect(r.stdout).not.toContain("No matching skills found");
    expect(await exists(path.join(w.store, "index.json"))).toBe(false);
  });

  test("project: -p drops the reference, -g deletes; scope must be explicit without a prompt", async () => {
    const w = await world();
    const proj = await w.dir("proj");
    const src = await w.write(await w.dir("src"), { "bar/SKILL.md": skillMd("bar", "Bar skill"), "qux/SKILL.md": skillMd("qux", "Qux skill") });
    await w.write(proj, { "skills/local/SKILL.md": skillMd("local", "Local skill") });
    await w.ok(["add", "-p", src, "-y", "-a", "codex", "claude-code"], { cwd: proj });
    await w.ok(["add", "-p", "./skills/local", "-y"], { cwd: proj });
    await w.ok(["add", "-g", path.join(src, "qux"), "-y"], { cwd: proj });
    await validateAll(w, [proj]);
    const manifest = () => fsp.readFile(path.join(proj, "skill-library.json"), "utf8");
    const before = await manifest();
    const beforeIndex = await fsp.readFile(path.join(w.store, "index.json"), "utf8");

    // -y, inside an agent, or no TTY: none of them picks the scope.
    const cases: Array<[string[], Record<string, string>]> = [[["remove", "bar", "-y"], {}], [["rm", "bar"], { CLAUDECODE: "1" }], [["r", "bar"], {}], [["remove", "--all"], {}]];
    for (const [args, env] of cases) {
      const r = await w.run(args, { cwd: proj, env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`This folder has a project (${path.join(proj, "skill-library.json")}); say where to remove from.`);
      expect(r.stderr).toContain("Use -p to drop the project's reference, or -g to delete from the global library.");
    }
    const pg = await w.run(["remove", "-p", "-g", "bar", "-y"], { cwd: proj });
    expect(pg.code).toBe(1);
    expect(pg.stderr).toContain("--global cannot be combined with --project");
    expect(await manifest()).toBe(before);
    expect(await fsp.readFile(path.join(w.store, "index.json"), "utf8")).toBe(beforeIndex);

    // -p -a: agents only.
    expect((await w.ok(["remove", "-p", "bar", "-a", "codex", "-y"], { cwd: proj })).stdout).toContain("✓ Updated agents for bar");
    expect((await readJson<Manifest>(path.join(proj, "skill-library.json"))).skills[`path://${path.join(src, "bar")}`]!.agents).toEqual(["claude-code"]);
    const allAgents = await w.ok(["remove", "-p", "local", "-a", "codex", "-y"], { cwd: proj });
    expect(allAgents.stdout).toContain("! local is available to all agents; remove it without -a");
    await validateAll(w, [proj]);

    // -p: the reference goes, the skill stays in the library (not global).
    const p = await w.ok(["remove", "--project", "bar", "-y"], { cwd: proj });
    expect(p.stdout).toContain("✓ Removed bar");
    const m = await readJson<Manifest>(path.join(proj, "skill-library.json"));
    expect(Object.keys(m.skills).sort()).toEqual(["local://skills/local", `path://${path.join(src, "qux")}`]);
    const bar = (await index(w)).skills.find((s) => s.id === `path://${path.join(src, "bar")}`)!;
    expect(bar.global).toBe(false);
    expect((await w.ok(["list", "-g", "--json"], { cwd: proj })).json().find((r: any) => r.name === "bar").status).toBe("untracked");
    await validateAll(w, [proj]);

    // A name that is global but not in the project: a note pointing at -g.
    await w.ok(["remove", "-p", "qux", "-y"], { cwd: proj });
    const notHere = await w.ok(["remove", "-p", "qux", "-y"], { cwd: proj });
    expect(notHere.stderr).toContain("qux is not in this project but in the global library; use -g");
    expect(notHere.stdout).toContain("No matching skills found for: qux");

    // -g of a skill the project still references: deleted, with a hint about install.
    await w.ok(["add", "-p", path.join(src, "qux"), "-y"], { cwd: proj });
    const g = await w.ok(["remove", "-g", "qux", "-y"], { cwd: proj });
    expect(g.stderr).toContain(`qux is still referenced by ${path.join(proj, "skill-library.json")}; run skill-library install to fetch it again`);
    expect((await index(w)).skills.some((s) => s.id.endsWith("/qux"))).toBe(false);
    await validateAll(w); // the manifest now pins a skill the library lacks: list shows it missing
    expect((await w.ok(["list", "--json"], { cwd: proj })).json().find((r: any) => r.name === "qux").status).toBe("missing");
    await w.ok(["install"], { cwd: proj });
    await validateAll(w, [proj]);

    // -p --all drops every reference; the library keeps the skills.
    const before2 = (await index(w)).skills.length;
    const all = await w.ok(["remove", "-p", "--all"], { cwd: proj });
    expect(all.stdout).toContain("Successfully removed 2 skill(s)");
    expect((await readJson<Manifest>(path.join(proj, "skill-library.json"))).skills).toEqual({});
    expect((await index(w)).skills.length).toBe(before2);
    await validateAll(w, [proj]);
  });

  test("-p without a skill-library.json, and ambiguous project names, change nothing", async () => {
    const w = await world();
    const proj = await w.dir("proj");
    const r = await w.run(["remove", "-p", "x", "-y"], { cwd: proj });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No skill-library.json here, so there is no project to remove from.");
    expect(r.stderr).toContain("Drop -p to remove from the global library.");
    expect(await exists(path.join(proj, "skill-library.json"))).toBe(false);

    await w.write(proj, { "a/react/SKILL.md": skillMd("react", "one"), "b/react/SKILL.md": skillMd("react", "two") });
    await w.ok(["add", "-p", "./a/react", "-y"], { cwd: proj });
    await w.ok(["add", "-p", "./b/react", "-y"], { cwd: proj });
    const before = await fsp.readFile(path.join(proj, "skill-library.json"), "utf8");
    const amb = await w.run(["remove", "-p", "react", "-y"], { cwd: proj });
    expect(amb.code).toBe(1);
    expect(amb.stderr).toContain('"react" matches several skills');
    expect(await fsp.readFile(path.join(proj, "skill-library.json"), "utf8")).toBe(before);
    await w.ok(["remove", "-p", "local://a/react", "-y"], { cwd: proj });
    expect(Object.keys((await readJson<Manifest>(path.join(proj, "skill-library.json"))).skills)).toEqual(["local://b/react"]);
    await validateAll(w, [proj]);
  });

  test("inline forms: --skill=a,b and --agent=<agent> work like -s and -a", async () => {
    const { w } = await seeded();
    // --agent= drops codex from beta (codex + claude-code): beta stays, for Claude Code only.
    await w.ok(["remove", "beta", "-g", "-y", "--agent=codex"]);
    expect((await index(w)).skills.find((r) => r.versions[r.current]!.name === "beta")!.agents).toEqual(["claude-code"]);
    await validateAll(w);
    await w.ok(["remove", "-g", "--yes", "--skill=alpha,gamma"]);
    expect(await names(w)).toEqual(["beta"]);
    await validateAll(w);
  });

  test("a missing -a / --agent value is a usage error and changes nothing", async () => {
    const { w } = await seeded();
    const before = await fsp.readFile(path.join(w.store, "index.json"), "utf8");
    for (const args of [["remove", "beta", "-g", "-y", "-a"], ["remove", "beta", "-g", "-y", "--agent="]]) {
      expectUsageError(await w.run(args), "-a", "--agent");
    }
    expect(await fsp.readFile(path.join(w.store, "index.json"), "utf8")).toBe(before);
  });
});
