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
    for (const dirent of await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        await walk(root, relPath);
      } else if (dirent.isFile()) {
        out[`${root}:${relPath}`] = await fsp.readFile(path.join(root, relPath), "utf8");
      }
    }
  };

  for (const dir of dirs) {
    await walk(dir, "");
  }

  return out;
}

const index = (testWorld: World): Promise<StoreIndex> => readJson(path.join(testWorld.store, "index.json"));
const manifest = (dir: string): Promise<Manifest> => readJson(path.join(dir, "skill-library.json"));
const entry = async (dir: string, name: string) => Object.entries((await manifest(dir)).skills).find(([id]) => id.endsWith(`/${name}`))!;
const record = async (testWorld: World, name: string) => (await index(testWorld)).skills.find((skill) => skill.id.endsWith(`/${name}`))!;

/** A monorepo with skills a and b, added to a project (-p) and nothing global. */
async function projectSetup(testWorld: World): Promise<{ repo: Repo; proj: string }> {
  const repo = await testWorld.repo("mono", { "skills/a/SKILL.md": skillMd("a", "Skill A v1"), "skills/b/SKILL.md": skillMd("b", "Skill B v1") });
  const proj = await testWorld.dir("proj");

  await testWorld.ok(["add", repo.url, "-p", "-y", "-s", "*"], { cwd: proj });
  await validateAll(testWorld, [proj]);

  return { repo, proj };
}

describe("check", () => {
  test("up to date: exit 0 and the summary line; check never writes", async () => {
    const testWorld = await world();
    const { proj } = await projectSetup(testWorld);
    const before = await snapshot([testWorld.store, proj]);
    const result = await testWorld.run(["check"], { cwd: proj });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Checking project skills…");
    expect(result.stdout).toContain("a is up to date");
    expect(result.stdout).toContain("b is up to date");
    expect(result.stdout).toContain("All skills are up to date.");
    expect(await snapshot([testWorld.store, proj])).toEqual(before);
  });

  test("an upstream change to the skill is an update (exit 1, nothing written); a change to a sibling skill is not", async () => {
    const testWorld = await world();
    const { repo, proj } = await projectSetup(testWorld);

    // Only b changes: a's folder tree is identical, so a has no update even though the repo moved.
    await repo.commit({ "skills/b/SKILL.md": skillMd("b", "Skill B v2") });
    const before = await snapshot([testWorld.store, proj]);
    const result = await testWorld.run(["check"], { cwd: proj });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("a is up to date");
    expect(result.stdout).toContain("b has an update");
    expect(result.stdout).toContain("1 skill(s) have updates. Run skill-library update to apply them.");
    expect(await snapshot([testWorld.store, proj])).toEqual(before);
    // A commit outside every skill folder is not an update either.
    await testWorld.ok(["update", "b"], { cwd: proj });
    await repo.commit({ "README.md": "docs only" });
    const after = await testWorld.run(["check"], { cwd: proj });

    expect(after.code, after.stdout).toBe(0);
    expect(after.stdout).toContain("All skills are up to date.");
  });

  test("scope flags: -g, -p, -g -p and named skills; -y is accepted", async () => {
    const testWorld = await world();
    const { repo, proj } = await projectSetup(testWorld);
    const globRepo = await testWorld.repo("glob", { "SKILL.md": skillMd("solo", "Solo v1") });

    await testWorld.ok(["add", globRepo.url, "-g", "-y"], { cwd: proj });
    await globRepo.commit({ "SKILL.md": skillMd("solo", "Solo v2") });
    await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v2") });

    const def = await testWorld.run(["check"], { cwd: proj });

    expect(def.stdout).toContain("Checking project skills…");
    expect(def.stdout).toContain("a has an update");
    expect(def.stdout).not.toContain("solo");

    const glob = await testWorld.run(["check", "-g", "-y"], { cwd: proj });

    expect(glob.code).toBe(1);
    expect(glob.stdout).toContain("Checking global skills…");
    expect(glob.stdout).toContain("solo has an update");
    expect(glob.stdout).not.toMatch(/\ba has/);

    const proj1 = await testWorld.run(["check", "-p"], { cwd: proj });

    expect(proj1.stdout).toContain("Checking project skills…");
    expect(proj1.stdout).not.toContain("solo");

    for (const flags of [["-g", "-p"], ["--global", "--project"]]) {
      const both = await testWorld.run(["check", ...flags], { cwd: proj });

      expect(both.stdout).toContain("Checking project and global skills…");
      expect(both.stdout).toContain("a has an update");
      expect(both.stdout).toContain("solo has an update");
      expect(both.stdout).toContain("2 skill(s) have updates.");
    }

    // Named skills look in both scopes.
    const named = await testWorld.run(["check", "solo"], { cwd: proj });

    expect(named.stdout).toContain("Checking project and global skills…");
    expect(named.stdout).toContain("solo has an update");
    expect(named.stdout).not.toMatch(/\bb is/);

    // Outside the project: global only.
    const outside = await testWorld.run(["check"], { cwd: testWorld.home });

    expect(outside.stdout).toContain("Checking global skills…");
    expect(outside.stdout).toContain("solo has an update");
    await validateAll(testWorld, [proj]);
  });

  test("an unreachable upstream is a failure (exit 1); empty scopes say so", async () => {
    const testWorld = await world();
    const empty = await testWorld.ok(["check"], { cwd: testWorld.home });

    expect(empty.stdout).toContain("No global skills to check.");
    const repo = await testWorld.repo("gone", { "SKILL.md": skillMd("gone", "Gone soon") });

    await testWorld.ok(["add", repo.url, "-g", "-y"]);
    await fsp.rm(repo.bare, { recursive: true, force: true });
    const result = await testWorld.run(["check"], { cwd: testWorld.home });

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/✗ gone: /);
    expect(result.stdout).toContain("All skills are up to date.");
    await validateAll(testWorld);
  });
});

describe("update", () => {
  test("project: moves this project's pin, keeps the old version; another project pinned to it is untouched", async () => {
    const testWorld = await world();
    const { repo, proj } = await projectSetup(testWorld);
    const other = await testWorld.dir("other");

    await testWorld.ok(["add", repo.url, "-p", "-y", "-s", "a"], { cwd: other });
    const [aId, a1] = await entry(proj, "a");
    const b1 = (await entry(proj, "b"))[1];
    const v2 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v2"), "skills/a/extra.md": "more" });

    const result = await testWorld.run(["update"], { cwd: proj });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Updating project skills…");
    expect(result.stdout).toContain(`Updated a ${a1.commit!.slice(0, 7)} → ${v2.slice(0, 7)}`);
    expect(result.stdout).toContain("b is up to date");

    const a2 = (await entry(proj, "a"))[1];

    expect(a2.commit).toBe(v2);
    expect(a2.hash).not.toBe(a1.hash);
    expect((await entry(proj, "b"))[1]).toEqual(b1);
    expect((await entry(other, "a"))[1]).toEqual(a1);
    const rec = (await index(testWorld)).skills.find((skill) => skill.id === aId)!;

    expect(Object.values(rec.versions).map((version) => version.commit).sort()).toEqual([a1.commit, v2].sort());
    expect(rec.global).toBe(false);
    await validateAll(testWorld, [proj, other]);

    // The new version's files are in the library; the old project still lists its pin as installed.
    const key = Object.entries(rec.versions).find(([, version]) => version.commit === v2)![0];

    expect(await fsp.readFile(path.join(testWorld.store, rec.dir, key, "extra.md"), "utf8")).toBe("more");
    const otherRows = (await testWorld.ok(["list", "--json"], { cwd: other })).json();

    expect(otherRows.map((row: any) => [row.name, row.status])).toEqual([["a", "tracked"]]);

    // Running again changes nothing.
    const again = await testWorld.ok(["update"], { cwd: proj });

    expect(again.stdout).toContain("a is up to date");
    await validateAll(testWorld, [proj, other]);
  });

  test("-g moves current; the upgrade alias and -y work the same", async () => {
    const testWorld = await world();
    const repo = await testWorld.repo("g", { "SKILL.md": skillMd("solo", "Solo v1") });

    await testWorld.ok(["add", repo.url, "-g", "-y"]);
    const first = (await record(testWorld, "solo")).current;
    const v2 = await repo.commit({ "SKILL.md": skillMd("solo", "Solo v2") });
    const result = await testWorld.run(["upgrade", "-g", "-y"], { cwd: testWorld.home });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Updating global skills…");
    expect(result.stdout).toContain("Updated solo");
    const rec = await record(testWorld, "solo");

    expect(rec.versions[rec.current]!.commit).toBe(v2);
    expect(rec.versions[rec.current]!.description).toBe("Solo v2");
    expect(rec.versions[first]).toBeDefined();
    await validateAll(testWorld);

    const v3 = await repo.commit({ "SKILL.md": skillMd("solo", "Solo v3") });

    await testWorld.ok(["update", "--global"], { cwd: testWorld.home });
    expect((await record(testWorld, "solo")).current).toBe(v3.slice(0, 12));
    await validateAll(testWorld);
  });

  test("scopes: -p only touches the project, -g -p both, named skills both", async () => {
    const testWorld = await world();
    const { repo, proj } = await projectSetup(testWorld);
    const globRepo = await testWorld.repo("glob", { "SKILL.md": skillMd("solo", "Solo v1") });

    await testWorld.ok(["add", globRepo.url, "-g", "-y"], { cwd: proj });
    const solo1 = (await record(testWorld, "solo")).current;

    await globRepo.commit({ "SKILL.md": skillMd("solo", "Solo v2") });
    const a2 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v2") });

    await testWorld.ok(["update", "-p"], { cwd: proj });
    expect((await entry(proj, "a"))[1].commit).toBe(a2);
    expect((await record(testWorld, "solo")).current).toBe(solo1);
    await validateAll(testWorld, [proj]);

    const solo2 = await globRepo.commit({ "SKILL.md": skillMd("solo", "Solo v3") });
    const a3 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v3") });
    const both = await testWorld.ok(["update", "-g", "-p"], { cwd: proj });

    expect(both.stdout).toContain("Updating project and global skills…");
    expect((await entry(proj, "a"))[1].commit).toBe(a3);
    expect((await record(testWorld, "solo")).current).toBe(solo2.slice(0, 12));
    await validateAll(testWorld, [proj]);

    // Named: only that skill moves.
    const a4 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v4"), "skills/b/SKILL.md": skillMd("b", "Skill B v4") });
    const named = await testWorld.ok(["update", "a"], { cwd: proj });

    expect(named.stdout).toContain("Updated a");
    expect(named.stdout).not.toMatch(/\bb\b/);
    expect((await entry(proj, "a"))[1].commit).toBe(a4);
    expect((await entry(proj, "b"))[1].commit).not.toBe(a4);
    await validateAll(testWorld, [proj]);
  });

  test("local sources are skipped with a hint; a built-in name gets a note; empty scope says so", async () => {
    const testWorld = await world();
    const empty = await testWorld.ok(["update"], { cwd: testWorld.home });

    expect(empty.stdout).toContain("No global skills to update.");
    const src = await testWorld.write(await testWorld.dir("src"), { "loc/SKILL.md": skillMd("loc", "Local skill") });

    await testWorld.ok(["add", path.join(src, "loc"), "-g", "-y"]);
    const before = await snapshot([testWorld.store]);
    const result = await testWorld.ok(["update"], { cwd: testWorld.home });

    expect(result.stdout).toContain("Skipped:");
    expect(result.stdout).toContain("loc (Local path)");
    expect(result.stdout).toContain("To update a local skill: skill-library add <path>");
    expect(await snapshot([testWorld.store])).toEqual(before);

    const builtin = await testWorld.ok(["update", "find-skills"], { cwd: testWorld.home });

    expect(builtin.stderr).toContain("find-skills is built into skill-library: it can't be removed or updated on its own");
    const chk = await testWorld.ok(["check", "find-skills"], { cwd: testWorld.home });

    expect(chk.stderr).toContain("find-skills is built into skill-library");
    await validateAll(testWorld);
  });

  test("unreachable upstream: failed row, exit 1, pin unchanged", async () => {
    const testWorld = await world();
    const { repo, proj } = await projectSetup(testWorld);
    const before = await snapshot([testWorld.store, proj]);

    await fsp.rm(repo.bare, { recursive: true, force: true });
    const result = await testWorld.run(["update"], { cwd: proj });

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/✗ a: /);
    expect(result.stdout).toMatch(/✗ b: /);
    expect(await snapshot([testWorld.store, proj])).toEqual(before);
    await validateAll(testWorld, [proj]);
  });

  test("a skill deleted upstream is skipped (removed upstream) and keeps its pin", async () => {
    const testWorld = await world();
    const { repo, proj } = await projectSetup(testWorld);
    const b1 = (await entry(proj, "b"))[1];

    await repo.commit({}, ["skills/b"]);
    const chk = await testWorld.run(["check"], { cwd: proj });

    expect(chk.stdout).toContain("b (removed upstream)");
    const result = await testWorld.ok(["update"], { cwd: proj });

    expect(result.stdout).toContain("b (removed upstream)");
    expect((await entry(proj, "b"))[1]).toEqual(b1);
    await validateAll(testWorld, [proj]);
  });

  test("a renamed skill upstream: the pin moves and the manifest takes the new name", async () => {
    const testWorld = await world();
    const repo = await testWorld.repo("ren", { "SKILL.md": skillMd("old", "Old name") });
    const proj = await testWorld.dir("proj");

    await testWorld.ok(["add", repo.url, "-p", "-y"], { cwd: proj });
    const v2 = await repo.commit({ "SKILL.md": skillMd("new", "New name") });

    await testWorld.ok(["update"], { cwd: proj });
    const projectManifest = await manifest(proj);
    const [id, skillEntry] = Object.entries(projectManifest.skills)[0]!;

    expect(id.endsWith("/old")).toBe(true);
    expect(skillEntry.name).toBe("new");
    expect(skillEntry.commit).toBe(v2);
    await validateStore(testWorld);
    await validateManifest(testWorld, proj);
    const rows = (await testWorld.ok(["list", "--json"], { cwd: proj })).json();

    expect(rows.map((row: any) => row.name)).toEqual(["new"]);
  });

  test("a project with only local:// skills has nothing to update", async () => {
    const testWorld = await world();
    const proj = await testWorld.dir("proj");

    await testWorld.write(proj, { "skills/mine/SKILL.md": skillMd("mine", "In repo") });
    await testWorld.ok(["add", "./skills/mine", "-p", "-y"], { cwd: proj });
    const result = await testWorld.ok(["update", "-p"], { cwd: proj });

    expect(result.stdout).toContain("No project skills to update.");
    await validateAll(testWorld, [proj]);
  });

  test("long forms: update --project --yes and check --global --yes behave like -p -y and -g -y", async () => {
    const testWorld = await world();
    const { repo, proj } = await projectSetup(testWorld);
    const globRepo = await testWorld.repo("glob", { "SKILL.md": skillMd("glob", "Global v1") });

    await testWorld.ok(["add", globRepo.url, "-g", "-y"]);
    const g1 = globRepo.head;

    await validateAll(testWorld, [proj]);
    const v2 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "Skill A v2") });
    const g2 = await globRepo.commit({ "SKILL.md": skillMd("glob", "Global v2") });
    const chk = await testWorld.run(["check", "--global", "--yes"], { cwd: proj });

    expect(chk.code).toBe(1);
    expect(chk.stdout).toContain("glob has an update");
    expect(chk.stdout).not.toContain("a has an update");
    const chkP = await testWorld.run(["check", "--project", "--yes"], { cwd: proj });

    expect(chkP.code).toBe(1);
    expect(chkP.stdout).toContain("a has an update");
    await testWorld.ok(["update", "--project", "--yes"], { cwd: proj });
    expect((await entry(proj, "a"))[1].commit).toBe(v2);
    expect((await record(testWorld, "glob")).current).toBe(g1.slice(0, 12)); // -p left the global skill alone
    await validateAll(testWorld, [proj]);
    await testWorld.ok(["upgrade", "--global", "--yes"], { cwd: proj });
    expect((await record(testWorld, "glob")).current).toBe(g2.slice(0, 12));
    await validateAll(testWorld, [proj]);
  });
});
