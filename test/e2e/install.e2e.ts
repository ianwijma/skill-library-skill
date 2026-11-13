// `install` (aliases `i` without a source, `experimental_install`): restore a project's skills at
// their pinned versions, verifying content hashes.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { exists, readJson, skillMd, world, type World } from "./harness.ts";
import { validateAll, validateManifest, validateStore, type Manifest, type StoreIndex } from "./validate.ts";

async function writeManifest(dir: string, skills: Record<string, unknown>, version: unknown = 1): Promise<void> {
  await fsp.writeFile(path.join(dir, "skill-library.json"), JSON.stringify({ version, skills }, null, 2));
}

async function editManifest(dir: string, fn: (m: Manifest) => void): Promise<void> {
  const file = path.join(dir, "skill-library.json");
  const manifest = await readJson<Manifest>(file);

  fn(manifest);
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2));
}

async function index(testWorld: World): Promise<StoreIndex> {
  return readJson<StoreIndex>(path.join(testWorld.store, "index.json"));
}

/** Folder of the version a project entry pins, in `w`'s library. */
async function pinnedDir(testWorld: World, id: string, commit?: string): Promise<string> {
  const rec = (await index(testWorld)).skills.find((record) => record.id === id)!;
  const key = Object.entries(rec.versions).find(([, version]) => (commit ? version.commit === commit : true))![0];

  return path.join(testWorld.store, rec.dir, key);
}

describe("install", () => {
  test("a fresh machine restores every pinned version, even after upstream moved on", async () => {
    const machineA = await world();
    const proj = await machineA.dir("proj");
    const gh = await machineA.github("acme/skills", {
      "skills/react/SKILL.md": skillMd("react", "React rules v1"),
      "skills/vue/SKILL.md": skillMd("vue", "Vue rules v1"),
    });
    const other = await machineA.repo("solo", { "SKILL.md": skillMd("solo", "Solo skill v1") });

    await machineA.write(proj, { "skills/inrepo/SKILL.md": skillMd("inrepo", "In repo skill") });
    await machineA.ok(["add", "-p", "acme/skills", "-y"], { cwd: proj });
    await machineA.ok(["add", "-p", other.url, "-y", "-a", "codex"], { cwd: proj });
    await machineA.ok(["add", "-p", "./skills/inrepo", "-y"], { cwd: proj });
    const manifest = await validateManifest(machineA, proj);

    expect(Object.keys(manifest.skills)).toEqual([
      "local://skills/inrepo",
      "repo://github.com/acme/skills/react",
      "repo://github.com/acme/skills/vue",
      expect.stringMatching(/^repo:\/\/localhost\/.*\/solo$/),
    ]);
    const pinned = gh.head;

    expect(manifest.skills["repo://github.com/acme/skills/react"]!.commit).toBe(pinned);
    await validateAll(machineA, [proj]);

    // Upstream moves on; the project keeps its pins.
    await gh.commit({ "skills/react/SKILL.md": skillMd("react", "React rules v2") });
    await other.commit({ "SKILL.md": skillMd("solo", "Solo skill v2") });

    const machineB = await machineA.machine("b");
    const dry = await machineB.ok(["install", "--dry-run"], { cwd: proj });

    expect(dry.stdout).toContain("Restoring 4 skill(s)");
    expect(dry.stdout).toContain("→ Would restore repo://github.com/acme/skills/react");
    expect(dry.stdout).toContain("• local://skills/inrepo (in this repository)");
    expect(await exists(machineB.store)).toBe(false);

    const result = await machineB.ok(["install"], { cwd: proj });

    expect(result.stdout).toContain("✓ Installed repo://github.com/acme/skills/react");
    expect(result.stdout).toContain("✓ Installed repo://github.com/acme/skills/vue");
    expect(result.stdout).toMatch(/✓ Installed repo:\/\/localhost\/.*\/solo/);
    expect(result.stdout).toContain("local://skills/inrepo (in this repository)");
    await validateManifest(machineB, proj);
    const idx = await validateAll(machineB, [proj]);
    // Restored at the pin (v1), never the upstream head (v2); not global on the new machine.
    const react = idx.skills.find((skill) => skill.id === "repo://github.com/acme/skills/react")!;

    expect(react.versions[react.current]!.commit).toBe(pinned);
    expect(react.versions[react.current]!.description).toBe("React rules v1");
    expect(idx.skills.every((skill) => !skill.global)).toBe(true);
    expect(await fsp.readFile(path.join(await pinnedDir(machineB, react.id), "SKILL.md"), "utf8")).toContain("React rules v1");
    const rows = (await machineB.ok(["list", "--json"], { cwd: proj })).json();

    expect(rows.every((row: any) => row.status === "tracked")).toBe(true);

    // Second run: nothing to do.
    const again = await machineB.ok(["install"], { cwd: proj });

    expect(again.stdout).toContain("• repo://github.com/acme/skills/react (already installed)");
    expect(again.stdout).toContain("Everything is already installed.");
    // Aliases restore the same way.
    expect((await machineB.ok(["i"], { cwd: proj })).stdout).toContain("Everything is already installed.");
    expect((await machineB.ok(["experimental_install"], { cwd: proj })).stdout).toContain("Everything is already installed.");
    // -a is accepted and ignored (also for `i`, which would otherwise read it as an add source list), -y too.
    expect((await machineB.ok(["i", "-a", "codex"], { cwd: proj })).stdout).toContain("Everything is already installed.");
    expect((await machineB.ok(["install", "-a", "claude-code", "codex", "-y"], { cwd: proj })).stdout).toContain("Everything is already installed.");
    await validateAll(machineB, [proj]);
  });

  test("--force repairs a tampered version folder; without it the copy is kept; a missing SKILL.md is always repaired", async () => {
    const testWorld = await world();
    const proj = await testWorld.dir("proj");
    const repo = await testWorld.repo("r", { "SKILL.md": skillMd("solo", "Solo skill"), "ref.md": "reference" });

    await testWorld.ok(["add", "-p", repo.url, "-y"], { cwd: proj });
    const before = await fsp.readFile(path.join(proj, "skill-library.json"), "utf8");
    const id = Object.keys(JSON.parse(before).skills)[0]!;
    const dir = await pinnedDir(testWorld, id);

    await fsp.writeFile(path.join(dir, "ref.md"), "tampered");
    await expect(validateStore(testWorld)).rejects.toThrow(/store is inconsistent/);
    const plain = await testWorld.ok(["install"], { cwd: proj });

    expect(plain.stdout).toContain(`• ${id} (already installed)`);
    expect(await fsp.readFile(path.join(dir, "ref.md"), "utf8")).toBe("tampered");

    const forced = await testWorld.ok(["install", "--force"], { cwd: proj });

    expect(forced.stdout).toContain(`✓ Repaired ${id}`);
    expect(await fsp.readFile(path.join(dir, "ref.md"), "utf8")).toBe("reference");
    expect(await fsp.readFile(path.join(proj, "skill-library.json"), "utf8")).toBe(before);
    await validateAll(testWorld, [proj]);
    expect((await testWorld.ok(["install", "--force"], { cwd: proj })).stdout).toContain("Everything is already installed.");

    await fsp.rm(path.join(dir, "SKILL.md"));
    const repaired = await testWorld.ok(["install"], { cwd: proj });

    expect(repaired.stdout).toContain(`✓ Repaired ${id}`);
    await validateAll(testWorld, [proj]);

    // --dry-run reports the repair and changes nothing.
    await fsp.writeFile(path.join(dir, "ref.md"), "tampered again");
    const dry = await testWorld.ok(["install", "--force", "--dry-run"], { cwd: proj });

    expect(dry.stdout).toContain(`→ Would restore ${id}`);
    expect(await fsp.readFile(path.join(dir, "ref.md"), "utf8")).toBe("tampered again");
  });

  test("a pin whose content doesn't match, or whose commit is gone, is refused with exit 1", async () => {
    const machineA = await world();
    const proj = await machineA.dir("proj");
    const repo = await machineA.repo("r", { "SKILL.md": skillMd("solo", "Solo skill") });

    await machineA.ok(["add", "-p", repo.url, "-y"], { cwd: proj });
    const id = Object.keys((await readJson<Manifest>(path.join(proj, "skill-library.json"))).skills)[0]!;

    // The manifest pins a hash the commit's content doesn't have.
    await editManifest(proj, (manifest) => (manifest.skills[id]!.hash = `sha256-${"0".repeat(64)}`));
    const machineB = await machineA.machine("b");
    const bad = await machineB.run(["install"], { cwd: proj });

    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain(`✗ ${id}: ${id}: content hash does not match skill-library.json`);
    expect(bad.stdout).toContain("refusing to install");
    await validateStore(machineB);
    expect((await readJson<StoreIndex>(path.join(machineB.store, "index.json")).catch(() => ({ skills: [] }) as any)).skills).toEqual([]);

    // Upstream history rewritten: the pinned commit no longer exists.
    await editManifest(proj, (manifest) => (manifest.skills[id]!.commit = "f".repeat(40)));
    const gone = await machineB.run(["install"], { cwd: proj });

    expect(gone.code).toBe(1);
    expect(gone.stdout).toContain(`✗ ${id}: Failed to fetch ffffffffffff`);
    await validateStore(machineB);
  });

  test("home:// and path:// entries restore from their folders; a changed folder is refused", async () => {
    const machineA = await world();
    const proj = await machineA.dir("proj");
    const outside = await machineA.write(await machineA.dir("shared"), { "ext/SKILL.md": skillMd("ext", "External skill") });

    await machineA.write(path.join(machineA.home, "mine"), { "own/SKILL.md": skillMd("own", "Home skill") });
    await machineA.ok(["add", "-p", path.join(outside, "ext"), "-y"], { cwd: proj });
    await machineA.ok(["add", "-p", path.join(machineA.home, "mine", "own"), "-y"], { cwd: proj });
    const manifest = await validateManifest(machineA, proj);

    expect(manifest.skills["home://mine/own"]).toMatchObject({ name: "own", source: "~/mine/own" });
    expect(manifest.skills[`path://${path.join(outside, "ext")}`]).toMatchObject({ name: "ext", source: path.join(outside, "ext") });

    // Machine b has the same home folder (the user copied it over) and sees the same absolute path.
    const machineB = await machineA.machine("b");

    await machineB.write(path.join(machineB.home, "mine"), { "own/SKILL.md": skillMd("own", "Home skill") });
    const result = await machineB.ok(["install"], { cwd: proj });

    expect(result.stdout).toContain("✓ Installed home://mine/own");
    expect(result.stdout).toContain(`✓ Installed path://${path.join(outside, "ext")}`);
    await validateAll(machineB, [proj]);

    // On machine c the home folder differs from the pin and the other folder is missing.
    const machineC = await machineA.machine("c");

    await machineC.write(path.join(machineC.home, "mine"), { "own/SKILL.md": skillMd("own", "Home skill, edited") });
    await fsp.rm(path.join(outside, "ext"), { recursive: true });
    const refused = await machineC.run(["install"], { cwd: proj });

    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("own changed since it was pinned; run skill-library add ~/mine/own to re-pin");
    expect(refused.stdout).toContain(`path://${path.join(outside, "ext")}: path://${path.join(outside, "ext")}: folder not found`);
    await validateStore(machineC);
  });

  test("frozen lockfile: --frozen-lockfile and CI need skills; --no-frozen-lockfile overrides; empty manifests", async () => {
    const testWorld = await world();
    const proj = await testWorld.dir("proj");
    // No skill-library.json at all.
    const none = await testWorld.ok(["install"], { cwd: proj });

    expect(none.stdout).toContain("No skills in skill-library.json.");

    for (const [args, env] of [[["install", "--frozen-lockfile"], {}], [["install"], { CI: "1" }], [["install"], { GITHUB_ACTIONS: "true" }]] as const) {
      const result = await testWorld.run([...args], { cwd: proj, env });

      expect(result.code, JSON.stringify([args, env])).toBe(1);
      expect(result.stderr).toContain("No skill-library.json found (frozen lockfile).");
    }

    // CI=false / 0 are not CI.
    expect((await testWorld.run(["install"], { cwd: proj, env: { CI: "false" } })).code).toBe(0);
    expect((await testWorld.run(["install"], { cwd: proj, env: { CI: "0" } })).code).toBe(0);
    expect((await testWorld.run(["install", "--no-frozen-lockfile"], { cwd: proj, env: { CI: "1" } })).code).toBe(0);

    // An empty manifest.
    await writeManifest(proj, {});
    expect((await testWorld.ok(["install"], { cwd: proj })).stdout).toContain("No skills in skill-library.json.");
    const frozen = await testWorld.run(["install", "--frozen-lockfile"], { cwd: proj });

    expect(frozen.code).toBe(1);
    expect(frozen.stderr).toContain("skill-library.json has no skills (frozen lockfile).");
    expect((await testWorld.run(["install"], { cwd: proj, env: { CI: "1" } })).code).toBe(1);
    expect((await testWorld.ok(["install", "--no-frozen-lockfile", "--frozen-lockfile"], { cwd: proj, env: { CI: "1" } })).stdout).toContain("No skills in skill-library.json.");
    expect(await exists(testWorld.store)).toBe(false);

    // A populated manifest passes frozen.
    const repo = await testWorld.repo("r", { "SKILL.md": skillMd("solo", "Solo") });

    await testWorld.ok(["add", "-p", repo.url, "-y"], { cwd: proj });
    expect((await testWorld.ok(["install", "--frozen-lockfile"], { cwd: proj, env: { CI: "1" } })).stdout).toContain("Everything is already installed.");
    await validateAll(testWorld, [proj]);
  });

  test("an invalid skill-library.json is rejected naming the file; nothing is written", async () => {
    const testWorld = await world();
    const proj = await testWorld.dir("proj");
    const file = path.join(proj, "skill-library.json");
    const hash = `sha256-${"0".repeat(64)}`;
    const cases: Array<[string, string]> = [
      ["{not json", "is not valid JSON"],
      [JSON.stringify({ version: 2, skills: {} }), "is not a skill-library.json (version 1)"],
      [JSON.stringify({ version: 1, skills: [] }), "is not a skill-library.json (version 1)"],
      [JSON.stringify({ version: 1 }), "is not a skill-library.json (version 1)"],
      [JSON.stringify({ version: 1, skills: { "repo://github.com/a/b/c": { source: "https://github.com/a/b.git", commit: "main", hash, agents: "all" } } }), "commit must be a full 40-hex commit SHA"],
      [JSON.stringify({ version: 1, skills: { "local://../outside": { agents: "all" } } }), "local:// path must stay inside the project"],
      [JSON.stringify({ version: 1, skills: { "home://x/bar": { source: "~/x/bar", agents: "all" } } }), "hash must be sha256-<64 hex>"],
      [JSON.stringify({ version: 1, skills: { "repo://github.com/a/b/c": { commit: "a".repeat(40), hash, agents: "all" } } }), "source is required"],
      [JSON.stringify({ version: 1, skills: { "repo://github.com/a/b/c": { source: "https://github.com/a/b.git", path: "../../etc", commit: "a".repeat(40), hash, agents: "all" } } }), "path must be a relative path inside the repository"],
      [JSON.stringify({ version: 1, skills: { "repo://github.com/a/b/c": { source: "https://github.com/a/b.git", commit: "a".repeat(40), hash, agents: "nobody" } } }), 'agents must be "all" or a list of agent ids'],
      [JSON.stringify({ version: 1, skills: { "ftp://x": { source: "x", hash, agents: "all" } } }), "unknown id prefix"],
    ];

    for (const [text, message] of cases) {
      await fsp.writeFile(file, text);

      for (const args of [["install"], ["install", "--dry-run"], ["i"]]) {
        const result = await testWorld.run(args, { cwd: proj });

        expect(result.code, `${args.join(",")} ${text}`).toBe(1);
        expect(result.stderr, text).toContain(file);
        expect(result.stderr, text).toContain(message);
      }
    }

    expect(await exists(testWorld.store)).toBe(false);
  });

  test("install from a nested folder uses the ancestor project", async () => {
    const machineA = await world();
    const proj = await machineA.dir("proj");
    const repo = await machineA.repo("r", { "SKILL.md": skillMd("solo", "Solo") });

    await machineA.ok(["add", "-p", repo.url, "-y"], { cwd: proj });
    const nested = await machineA.dir("proj/src/deep");
    const machineB = await machineA.machine("b");
    const result = await machineB.ok(["install"], { cwd: nested });

    expect(result.stdout).toMatch(/✓ Installed repo:\/\/localhost\/.*\/solo/);
    expect(await exists(path.join(nested, "skill-library.json"))).toBe(false);
    await validateAll(machineB, [proj]);
  });

  test("long and inline forms: --yes, --agent x, --agent=x and `i --agent x` are accepted; -a never makes `i` an add", async () => {
    const testWorld = await world();
    const proj = await testWorld.dir("proj");
    const repo = await testWorld.repo("solo", { "SKILL.md": skillMd("solo", "Solo skill") });

    await testWorld.ok(["add", repo.url, "-p", "-y"], { cwd: proj });
    const manifest = await validateManifest(testWorld, proj);

    await fsp.rm(testWorld.store, { recursive: true, force: true });
    // `i` with only flags (list flags eat their values) is a restore, not an add of "codex".
    const result = await testWorld.ok(["i", "--agent", "codex", "--yes"], { cwd: proj });

    expect(result.stdout).toContain(`Installed ${String(Object.keys(manifest.skills)[0])}`);
    await validateAll(testWorld, [proj]);

    for (const args of [["install", "--agent=codex"], ["install", "-a", "codex", "cursor", "-y"], ["experimental_install", "--yes", "--agent", "codex"]]) {
      const again = await testWorld.ok(args, { cwd: proj });

      expect(again.stdout, args.join(" ")).toContain("Everything is already installed.");
    }

    expect(await readJson(path.join(proj, "skill-library.json"))).toEqual(manifest);
    await validateAll(testWorld, [proj]);
  });
});
