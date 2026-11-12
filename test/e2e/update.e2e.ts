// `update` (alias `upgrade`) and `check`: scope rules, pins, tree comparison, failures.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { readJson, skillMd, world, type Repo, type World } from "./harness.ts";
import { validateAll, validateManifest, validateStore, type Manifest, type StoreIndex } from "./validate.ts";

/** Every file under `dirs` (relative path → content), for "wrote nothing" checks. */
async function snapshot(dirs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (root: string, rel: string): Promise<void> => {
    for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(root, p);
      else if (e.isFile()) out[`${root}:${p}`] = await fsp.readFile(path.join(root, p), "utf8");
    }
  };
  for (const d of dirs) await walk(d, "");
  return out;
}

const index = (w: World): Promise<StoreIndex> => readJson(path.join(w.store, "index.json"));
const manifest = (dir: string): Promise<Manifest> => readJson(path.join(dir, "skill-library.json"));
const entry = async (dir: string, name: string) => Object.entries((await manifest(dir)).skills).find(([id]) => id.endsWith(`/${name}`))!;
const record = async (w: World, name: string) => (await index(w)).skills.find((r) => r.id.endsWith(`/${name}`))!;

/** A monorepo with skills a and b, added to a project (-p) and nothing global. */
async function projectSetup(w: World): Promise<{ repo: Repo; proj: string }> {
  const repo = await w.repo("mono", { "skills/a/SKILL.md": skillMd("a", "Skill A v1"), "skills/b/SKILL.md": skillMd("b", "Skill B v1") });
  const proj = await w.dir("proj");
  await w.ok(["add", repo.url, "-p", "-y", "-s", "*"], { cwd: proj });
  await validateAll(w, [proj]);
  return { repo, proj };
}

describe("check", () => {
  test("up to date: exit 0 and the summary line; check never writes", async () => {
    const w = await world();
    const { proj } = await projectSetup(w);
    const before = await snapshot([w.store, proj]);
    const r = await w.run(["check"], { cwd: proj });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Checking project skills…");
    expect(r.stdout).toContain("a is up to date");
    expect(r.stdout).toContain("b is up to date");
    expect(r.stdout).toContain("All skills are up to date.");
    expect(await snapshot([w.store, proj])).toEqual(before);
  });

  test("an upstream change to the skill is an update (exit 1, nothing written); a change to a sibling skill is not", async () => {
    const w = await world();
    const { repo, proj } = await projectSetup(w);
    // Only b changes: a's folder tree is identical, so a has no update even though the repo moved.
    await repo.commit({ "skills/b/SKILL.md": skillMd("b", "Skill B v2") });
    const before = await snapshot([w.store, proj]);
    const r = await w.run(["check"], { cwd: proj });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("a is up to date");
    expect(r.stdout).toContain("b has an update");
    expect(r.stdout).toContain("1 skill(s) have updates. Run skill-library update to apply them.");
    expect(await snapshot([w.store, proj])).toEqual(before);
    // A commit outside every skill folder is not an update either.
    await w.ok(["update", "b"], { cwd: proj });
    await repo.commit({ "README.md": "docs only" });
    const after = await w.run(["check"], { cwd: proj });
    expect(after.code, after.stdout).toBe(0);
    expect(after.stdout).toContain("All skills are up to date.");
  });

  test("scope flags: -g, -p, -g -p and named skills; -y is accepted", async () => {
    const w = await world();
    const { repo, proj } = await projectSetup(w);
    const g = await w.repo("glob", { "SKILL.md": skillMd("solo", "Solo v1") });
    await w.ok(["add", g.url, "-g", "-y"], { cwd: proj });
    await g.commit({ "SKILL.md": skillMd("solo", "Solo v2") });
    await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v2") });

    const def = await w.run(["check"], { cwd: proj });
    expect(def.stdout).toContain("Checking project skills…");
    expect(def.stdout).toContain("a has an update");
    expect(def.stdout).not.toContain("solo");

    const glob = await w.run(["check", "-g", "-y"], { cwd: proj });
    expect(glob.code).toBe(1);
    expect(glob.stdout).toContain("Checking global skills…");
    expect(glob.stdout).toContain("solo has an update");
    expect(glob.stdout).not.toMatch(/\ba has/);

    const proj1 = await w.run(["check", "-p"], { cwd: proj });
    expect(proj1.stdout).toContain("Checking project skills…");
    expect(proj1.stdout).not.toContain("solo");

    for (const flags of [["-g", "-p"], ["--global", "--project"]]) {
      const both = await w.run(["check", ...flags], { cwd: proj });
      expect(both.stdout).toContain("Checking project and global skills…");
      expect(both.stdout).toContain("a has an update");
      expect(both.stdout).toContain("solo has an update");
      expect(both.stdout).toContain("2 skill(s) have updates.");
    }

    // Named skills look in both scopes.
    const named = await w.run(["check", "solo"], { cwd: proj });
    expect(named.stdout).toContain("Checking project and global skills…");
    expect(named.stdout).toContain("solo has an update");
    expect(named.stdout).not.toMatch(/\bb is/);

    // Outside the project: global only.
    const outside = await w.run(["check"], { cwd: w.home });
    expect(outside.stdout).toContain("Checking global skills…");
    expect(outside.stdout).toContain("solo has an update");
    await validateAll(w, [proj]);
  });

  test("an unreachable upstream is a failure (exit 1); empty scopes say so", async () => {
    const w = await world();
    const empty = await w.ok(["check"], { cwd: w.home });
    expect(empty.stdout).toContain("No global skills to check.");
    const repo = await w.repo("gone", { "SKILL.md": skillMd("gone", "Gone soon") });
    await w.ok(["add", repo.url, "-g", "-y"]);
    await fsp.rm(repo.bare, { recursive: true, force: true });
    const r = await w.run(["check"], { cwd: w.home });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/✗ gone: /);
    expect(r.stdout).toContain("All skills are up to date.");
    await validateAll(w);
  });
});

describe("update", () => {
  test("project: moves this project's pin, keeps the old version; another project pinned to it is untouched", async () => {
    const w = await world();
    const { repo, proj } = await projectSetup(w);
    const other = await w.dir("other");
    await w.ok(["add", repo.url, "-p", "-y", "-s", "a"], { cwd: other });
    const [aId, a1] = await entry(proj, "a");
    const b1 = (await entry(proj, "b"))[1];
    const v2 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v2"), "skills/a/extra.md": "more" });

    const r = await w.run(["update"], { cwd: proj });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Updating project skills…");
    expect(r.stdout).toContain(`Updated a ${a1.commit!.slice(0, 7)} → ${v2.slice(0, 7)}`);
    expect(r.stdout).toContain("b is up to date");

    const a2 = (await entry(proj, "a"))[1];
    expect(a2.commit).toBe(v2);
    expect(a2.hash).not.toBe(a1.hash);
    expect((await entry(proj, "b"))[1]).toEqual(b1);
    expect((await entry(other, "a"))[1]).toEqual(a1);
    const rec = (await index(w)).skills.find((s) => s.id === aId)!;
    expect(Object.values(rec.versions).map((v) => v.commit).sort()).toEqual([a1.commit, v2].sort());
    expect(rec.global).toBe(false);
    await validateAll(w, [proj, other]);

    // The new version's files are in the library; the old project still lists its pin as installed.
    const key = Object.entries(rec.versions).find(([, v]) => v.commit === v2)![0];
    expect(await fsp.readFile(path.join(w.store, rec.dir, key, "extra.md"), "utf8")).toBe("more");
    const otherRows = (await w.ok(["list", "--json"], { cwd: other })).json();
    expect(otherRows.map((x: any) => [x.name, x.status])).toEqual([["a", "tracked"]]);

    // Running again changes nothing.
    const again = await w.ok(["update"], { cwd: proj });
    expect(again.stdout).toContain("a is up to date");
    await validateAll(w, [proj, other]);
  });

  test("-g moves current; the upgrade alias and -y work the same", async () => {
    const w = await world();
    const repo = await w.repo("g", { "SKILL.md": skillMd("solo", "Solo v1") });
    await w.ok(["add", repo.url, "-g", "-y"]);
    const first = (await record(w, "solo")).current;
    const v2 = await repo.commit({ "SKILL.md": skillMd("solo", "Solo v2") });
    const r = await w.run(["upgrade", "-g", "-y"], { cwd: w.home });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Updating global skills…");
    expect(r.stdout).toContain("Updated solo");
    const rec = await record(w, "solo");
    expect(rec.versions[rec.current]!.commit).toBe(v2);
    expect(rec.versions[rec.current]!.description).toBe("Solo v2");
    expect(rec.versions[first]).toBeDefined();
    await validateAll(w);

    const v3 = await repo.commit({ "SKILL.md": skillMd("solo", "Solo v3") });
    await w.ok(["update", "--global"], { cwd: w.home });
    expect((await record(w, "solo")).current).toBe(v3.slice(0, 12));
    await validateAll(w);
  });

  test("scopes: -p only touches the project, -g -p both, named skills both", async () => {
    const w = await world();
    const { repo, proj } = await projectSetup(w);
    const g = await w.repo("glob", { "SKILL.md": skillMd("solo", "Solo v1") });
    await w.ok(["add", g.url, "-g", "-y"], { cwd: proj });
    const solo1 = (await record(w, "solo")).current;
    await g.commit({ "SKILL.md": skillMd("solo", "Solo v2") });
    const a2 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v2") });

    await w.ok(["update", "-p"], { cwd: proj });
    expect((await entry(proj, "a"))[1].commit).toBe(a2);
    expect((await record(w, "solo")).current).toBe(solo1);
    await validateAll(w, [proj]);

    const solo2 = await g.commit({ "SKILL.md": skillMd("solo", "Solo v3") });
    const a3 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v3") });
    const both = await w.ok(["update", "-g", "-p"], { cwd: proj });
    expect(both.stdout).toContain("Updating project and global skills…");
    expect((await entry(proj, "a"))[1].commit).toBe(a3);
    expect((await record(w, "solo")).current).toBe(solo2.slice(0, 12));
    await validateAll(w, [proj]);

    // Named: only that skill moves.
    const a4 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v4"), "skills/b/SKILL.md": skillMd("b", "Skill B v4") });
    const named = await w.ok(["update", "a"], { cwd: proj });
    expect(named.stdout).toContain("Updated a");
    expect(named.stdout).not.toMatch(/\bb\b/);
    expect((await entry(proj, "a"))[1].commit).toBe(a4);
    expect((await entry(proj, "b"))[1].commit).not.toBe(a4);
    await validateAll(w, [proj]);
  });

  test("local sources are skipped with a hint; a built-in name gets a note; empty scope says so", async () => {
    const w = await world();
    const empty = await w.ok(["update"], { cwd: w.home });
    expect(empty.stdout).toContain("No global skills to update.");
    const src = await w.write(await w.dir("src"), { "loc/SKILL.md": skillMd("loc", "Local skill") });
    await w.ok(["add", path.join(src, "loc"), "-g", "-y"]);
    const before = await snapshot([w.store]);
    const r = await w.ok(["update"], { cwd: w.home });
    expect(r.stdout).toContain("Skipped:");
    expect(r.stdout).toContain("loc (Local path)");
    expect(r.stdout).toContain("To update a local skill: skill-library add <path>");
    expect(await snapshot([w.store])).toEqual(before);

    const builtin = await w.ok(["update", "find-skills"], { cwd: w.home });
    expect(builtin.stderr).toContain("find-skills is built into skill-library: it can't be removed or updated on its own");
    const chk = await w.ok(["check", "find-skills"], { cwd: w.home });
    expect(chk.stderr).toContain("find-skills is built into skill-library");
    await validateAll(w);
  });

  test("unreachable upstream: failed row, exit 1, pin unchanged", async () => {
    const w = await world();
    const { repo, proj } = await projectSetup(w);
    const before = await snapshot([w.store, proj]);
    await fsp.rm(repo.bare, { recursive: true, force: true });
    const r = await w.run(["update"], { cwd: proj });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/✗ a: /);
    expect(r.stdout).toMatch(/✗ b: /);
    expect(await snapshot([w.store, proj])).toEqual(before);
    await validateAll(w, [proj]);
  });

  test("a skill deleted upstream is skipped (removed upstream) and keeps its pin", async () => {
    const w = await world();
    const { repo, proj } = await projectSetup(w);
    const b1 = (await entry(proj, "b"))[1];
    await repo.commit({}, ["skills/b"]);
    const chk = await w.run(["check"], { cwd: proj });
    expect(chk.stdout).toContain("b (removed upstream)");
    const r = await w.ok(["update"], { cwd: proj });
    expect(r.stdout).toContain("b (removed upstream)");
    expect((await entry(proj, "b"))[1]).toEqual(b1);
    await validateAll(w, [proj]);
  });

  test("a renamed skill upstream: the pin moves and the manifest takes the new name", async () => {
    const w = await world();
    const repo = await w.repo("ren", { "SKILL.md": skillMd("old", "Old name") });
    const proj = await w.dir("proj");
    await w.ok(["add", repo.url, "-p", "-y"], { cwd: proj });
    const v2 = await repo.commit({ "SKILL.md": skillMd("new", "New name") });
    await w.ok(["update"], { cwd: proj });
    const m = await manifest(proj);
    const [id, e] = Object.entries(m.skills)[0]!;
    expect(id.endsWith("/old")).toBe(true);
    expect(e.name).toBe("new");
    expect(e.commit).toBe(v2);
    await validateStore(w);
    await validateManifest(w, proj);
    const rows = (await w.ok(["list", "--json"], { cwd: proj })).json();
    expect(rows.map((x: any) => x.name)).toEqual(["new"]);
  });

  test("a project with only local:// skills has nothing to update", async () => {
    const w = await world();
    const proj = await w.dir("proj");
    await w.write(proj, { "skills/mine/SKILL.md": skillMd("mine", "In repo") });
    await w.ok(["add", "./skills/mine", "-p", "-y"], { cwd: proj });
    const r = await w.ok(["update", "-p"], { cwd: proj });
    expect(r.stdout).toContain("No project skills to update.");
    await validateAll(w, [proj]);
  });

  test("long forms: update --project --yes and check --global --yes behave like -p -y and -g -y", async () => {
    const w = await world();
    const { repo, proj } = await projectSetup(w);
    const g = await w.repo("glob", { "SKILL.md": skillMd("glob", "Global v1") });
    await w.ok(["add", g.url, "-g", "-y"]);
    const g1 = g.head;
    await validateAll(w, [proj]);
    const v2 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v2") });
    const g2 = await g.commit({ "SKILL.md": skillMd("glob", "Global v2") });
    const chk = await w.run(["check", "--global", "--yes"], { cwd: proj });
    expect(chk.code).toBe(1);
    expect(chk.stdout).toContain("glob has an update");
    expect(chk.stdout).not.toContain("a has an update");
    const chkP = await w.run(["check", "--project", "--yes"], { cwd: proj });
    expect(chkP.code).toBe(1);
    expect(chkP.stdout).toContain("a has an update");
    await w.ok(["update", "--project", "--yes"], { cwd: proj });
    expect((await entry(proj, "a"))[1].commit).toBe(v2);
    expect((await record(w, "glob")).current).toBe(g1.slice(0, 12)); // -p left the global skill alone
    await validateAll(w, [proj]);
    await w.ok(["upgrade", "--global", "--yes"], { cwd: proj });
    expect((await record(w, "glob")).current).toBe(g2.slice(0, 12));
    await validateAll(w, [proj]);
  });
});
