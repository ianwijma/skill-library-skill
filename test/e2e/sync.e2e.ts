// `sync` end to end: every subcommand and flag, through a local bare repository (file://) that
// several "machines" (sandboxed HOMEs) share. After every change the library and the sync state
// of each machine involved are validated, and the remote's files are read through a fresh clone.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fakeTypeSafe } from "./fakes.ts";
import { exists, readJson, skillMd, world, type World } from "./harness.ts";
import { expectUnknownOption, expectUsageError } from "./contract.ts";
import { remoteFiles, validateAll, validateSync } from "./validate.ts";

/** Global (tracked) skills by name, from `list -g --json`. */
async function globals(testWorld: World): Promise<Record<string, any>> {
  const rows = (await testWorld.ok(["list", "-g", "--json"], { cwd: testWorld.home })).json<any[]>();

  return Object.fromEntries(rows.filter((row) => row.status === "tracked").map((row) => [row.name, row]));
}

/** Library + sync state are consistent and settled (nothing uncommitted or unpushed). */
async function settled(...machines: World[]): Promise<void> {
  for (const machine of machines) {
    await validateAll(machine);
    await validateSync(machine, { settled: true });
  }
}

/** A folder skill under the machine's HOME (home:// id). */
async function folderSkill(testWorld: World, name: string, description = `${name} skill`): Promise<string> {
  const dir = path.join(testWorld.home, "skills-src", name);

  await testWorld.write(dir, { "SKILL.md": skillMd(name, description) });

  return dir;
}

const lastSegments = (machine: any) => Object.keys(machine?.skills ?? {}).map((id) => id.split("/").pop()).sort();
const bareOf = (url: string) => url.replace(/^file:\/\//, "");

/** Wait (bounded) until `check` holds; returns its last value. */
async function until<T>(check: () => Promise<T>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await check();

  while (!value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    value = await check();
  }

  return value;
}

describe("sync init", () => {
  test("seeds an empty repo with global git skills and a README; folder skills stay machine-only without a TTY", async () => {
    const machineA = await world();
    const up = await machineA.repo("upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha skill"), "skills/beta/SKILL.md": skillMd("beta", "Beta skill") });

    await machineA.ok(["add", up.url, "-g", "-y"]);
    await machineA.ok(["add", await folderSkill(machineA, "copy"), "-g", "-y"]);
    const remote = await machineA.emptyRemote("my-skills");

    const init = await machineA.ok(["sync", "init", remote]);

    expect(init.stdout).toContain("The repository was empty; added this machine's 2 global skill(s) to it.");
    expect(init.stdout).toContain("Kept machine-only (not synced): copy");
    expect(init.stdout).toContain("Share one with skill-library sync share <name>");
    expect(init.stdout).toContain("Added the repository's README.md.");
    expect(init.stdout).toContain(`with ${remote} (pushed)`);
    expect(init.stdout).toContain("Sync runs on its own from now on");
    await settled(machineA);

    const files = await remoteFiles(machineA, remote);

    expect(lastSegments(files.manifest)).toEqual(["alpha", "beta"]);

    for (const entry of Object.values(files.manifest!.skills)) {
      expect(entry).toMatchObject({ source: up.url, commit: up.head, ref: null });
    }

    expect(Object.values(files.manifest!.skills).map((entry) => entry.path).sort()).toEqual(["skills/alpha", "skills/beta"]);
    expect(files.skills).toEqual([]);
    expect(files.files).toEqual(["README.md", "skill-library.json"]);
    const readme = await fsp.readFile(path.join(files.dir, "README.md"), "utf8");

    expect(readme).toContain("Skill Library");
    expect(readme).toContain(`skill-library sync init ${remote}`);
    expect(readme).not.toContain("{{");

    const cfg = await readJson(path.join(machineA.store, "sync.json"));

    expect(cfg.url).toBe(remote);
    expect(cfg.enabled).toBe(true);
    const tracked = await globals(machineA);

    expect(Object.keys(tracked).sort()).toEqual(["alpha", "beta", "copy"]);
    expect(tracked.copy.id).toMatch(/^home:\/\//);
  });

  test("--share picks folder skills by name, several names, '*', or full id; --share without a value fails", async () => {
    const machineA = await world();

    for (const skillName of ["one", "two", "three"]) {
      await machineA.ok(["add", await folderSkill(machineA, skillName), "-g", "-y"]);
    }

    const ids = Object.fromEntries(
      Object.entries(await globals(machineA)).map(([skillName, row]) => [skillName, row.id as string]),
    );

    expectUsageError(await machineA.run(["sync", "init", await machineA.emptyRemote("x"), "--share"]), "--share");
    expect(await exists(path.join(machineA.store, "sync.json"))).toBe(false);

    const byName = await machineA.emptyRemote("by-name");

    await machineA.ok(["sync", "init", byName, "--share", "one"]);
    expect((await remoteFiles(machineA, byName)).skills).toEqual(["one"]);
    await settled(machineA);

    // Several names / '*' / full id: each on a fresh machine with the same folder skills.
    const cases: Array<[string, string[], string[]]> = [
      ["several", ["one", "two"], ["one", "two"]],
      ["star", ["*"], ["one", "three", "two"]],
      ["by-id", [ids.three!], ["three"]],
    ];

    for (const [name, share, want] of cases) {
      const machine = await machineA.machine(name);

      for (const skillName of ["one", "two", "three"]) {
        await machine.ok(["add", await folderSkill(machine, skillName), "-g", "-y"]);
      }

      const remote = await machine.emptyRemote(`share-${name}`);
      const share2 = share[0] === ids.three ? [(await globals(machine)).three.id] : share;
      const result = await machine.ok(["sync", "init", remote, "--share", ...share2]);

      expect((await remoteFiles(machine, remote)).skills, name).toEqual(want);
      const notShared = ["one", "two", "three"].filter((skillName) => !want.includes(skillName));

      if (notShared.length > 0) {
        expect(result.stdout).toContain(`Kept machine-only (not synced): ${notShared.sort().join(", ")}`);
      } else {
        expect(result.stdout).not.toContain("Kept machine-only");
      }

      const tracked = await globals(machine);

      for (const skillName of want) {
        expect(tracked[skillName].id, skillName).toMatch(new RegExp(`share-${name}/${skillName}$`));
      }

      for (const skillName of notShared) {
        expect(tracked[skillName].id, skillName).toMatch(/^home:\/\//);
      }

      await settled(machine);
    }
  });

  test("--no-readme, an existing README is kept without a TTY; seeding reports seeded and machine-only skills; init again is a no-op", async () => {
    const machineA = await world();
    const bare = await machineA.emptyRemote("no-readme");

    await machineA.ok(["sync", "init", bare, "--no-readme"]);
    expect((await remoteFiles(machineA, bare)).files).not.toContain("README.md");
    await settled(machineA);

    const machineB = await machineA.machine("b");
    const has = await machineB.repo("has-readme", { "README.md": "# Mine\n" });
    const kept = await machineB.ok(["sync", "init", has.url]);

    expect(kept.stdout).not.toContain("README");
    expect(await fsp.readFile(path.join((await remoteFiles(machineB, has.url)).dir, "README.md"), "utf8")).toBe("# Mine\n");
    await settled(machineB);

    const machineC = await machineA.machine("c");
    const up = await machineC.repo("upstream-c", { "SKILL.md": skillMd("solo", "Solo skill") });

    await machineC.ok(["add", up.url, "-g", "-y"]);
    await machineC.ok(["add", await folderSkill(machineC, "local-one"), "-g", "-y"]);
    const remote = await machineC.emptyRemote("seeded");
    const result = await machineC.ok(["sync", "init", remote]);

    expect(result.stdout).toContain("The repository was empty; added this machine's 1 global skill(s) to it.");
    expect(result.stdout).toContain("Kept machine-only (not synced): local-one");
    expect(result.stdout).toContain("Added the repository's README.md.");
    expect(result.stdout).toContain(`with ${remote} (pushed)`);
    expect(result.stdout).not.toContain("✗");
    const seeded = await remoteFiles(machineC, remote);

    expect(lastSegments(seeded.manifest)).toEqual(["solo"]);
    expect(seeded.skills).toEqual([]);
    expect(seeded.files).toEqual(["README.md", "skill-library.json"]);
    expect((await readJson(path.join(machineC.store, "sync.json"))).url).toBe(remote);
    await settled(machineC);

    // Again with the same URL: already set up, nothing changes.
    const head = machineC.git(path.join(machineC.store, "sync"), ["rev-parse", "HEAD"]);
    const text = await machineC.ok(["sync", "init", remote]);

    expect(text.stdout).toContain(`Sync is already set up with ${remote}`);
    expect(text.stderr).toBe("");
    expect(machineC.git(path.join(machineC.store, "sync"), ["rev-parse", "HEAD"])).toBe(head);
  });

  test("errors: missing URL, a different URL, an unreachable URL (nothing left behind)", async () => {
    const machineA = await world();

    expectUsageError(await machineA.run(["sync", "init"]), "git-url", "url");

    const bad = await machineA.run(["sync", "init", "file:///nonexistent/repo.git"]);

    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Failed to clone file:///nonexistent/repo.git");
    expect(await exists(path.join(machineA.store, "sync.json"))).toBe(false);
    expect(await exists(path.join(machineA.store, "sync"))).toBe(false);
    expect((await machineA.ok(["sync", "status"])).stdout).toContain("Sync is not set up. Run skill-library sync init <git-url>");
    const manual = await machineA.run(["sync"]);

    expect(manual.code).not.toBe(0);
    expect(manual.stderr).toContain("skill-library sync init <git-url>");

    const remote = await machineA.emptyRemote("first");

    await machineA.ok(["sync", "init", remote]);
    const other = await machineA.run(["sync", "init", await machineA.emptyRemote("second")]);

    expect(other.code).toBe(1);
    expect(other.stderr).toContain("already set up");
    expect(other.stderr).toContain("sync update");
    expect((await readJson(path.join(machineA.store, "sync.json"))).url).toBe(remote);
    await settled(machineA);
  });

  test("a second machine gets the same global skills: git skills at their pinned commits, own skills under repo:// ids", async () => {
    const machineA = await world();
    const up = await machineA.repo("upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha skill") });

    await machineA.ok(["add", up.url, "-g", "-y", "-a", "codex"]);
    await machineA.ok(["add", await folderSkill(machineA, "mine", "My own skill"), "-g", "-y"]);
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote, "--share", "mine"]);
    // Upstream moves on after the pin: B must still get the pinned commit at init.
    const pinned = up.head;

    const machineB = await machineA.machine("b");
    const init = await machineB.ok(["sync", "init", remote]);

    expect(init.stdout).toContain("+ alpha");
    expect(init.stdout).toContain("+ mine");
    await settled(machineA, machineB);
    const ga = await globals(machineA);
    const gb = await globals(machineB);

    expect(Object.keys(gb).sort()).toEqual(["alpha", "mine"]);
    expect(gb.alpha.id).toBe(ga.alpha.id);
    expect(gb.mine.id).toBe(ga.mine.id);
    expect(gb.mine.id).toMatch(/^repo:\/\/localhost\/.*my-skills\/mine$/);
    expect(gb.alpha.agents).toEqual(["Codex"]);
    expect(gb.alpha.path).toContain(pinned.slice(0, 12));
    expect(await fsp.readFile(path.join(gb.mine.path, "SKILL.md"), "utf8")).toContain("My own skill");
  });
});

describe("sync (manual run)", () => {
  test("in sync; upstream updates bump the pin and push; the other machine follows; clone edits are pushed", async () => {
    const machineA = await world();
    const up = await machineA.repo("upstream", { "skills/gamma/SKILL.md": skillMd("gamma", "Gamma v1") });

    await machineA.ok(["add", up.url, "-g", "-y"]);
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    const machineB = await machineA.machine("b");

    await machineB.ok(["sync", "init", remote]);

    const quiet = await machineA.ok(["sync"]);

    expect(quiet.stdout).toBe(`Global skills are in sync with ${remote}\n`);
    const lastSync = (await readJson(path.join(machineA.store, "sync-status.json"))).lastSync;

    expect(Date.parse(lastSync)).not.toBeNaN();

    const v2 = await up.commit({ "skills/gamma/SKILL.md": skillMd("gamma", "Gamma v2") });
    const synced = await machineA.ok(["sync"]);

    expect(synced.stdout).toContain("↑ gamma");
    expect(synced.stdout).toContain(`Synced global skills with ${remote} (pushed)`);
    expect(synced.stdout).not.toMatch(/^\s+[+-] /m);
    expect(Object.values((await remoteFiles(machineA, remote)).manifest!.skills)[0]).toMatchObject({ commit: v2 });
    await settled(machineA);

    await machineB.ok(["sync"]);
    expect((await globals(machineB)).gamma.path).toContain(v2.slice(0, 12));
    await settled(machineB);

    // An edit made directly in A's clone is committed and pushed by the next sync.
    const clone = path.join(machineA.store, "sync");

    await machineA.write(clone, { "skills/handmade/SKILL.md": skillMd("handmade", "Made in the clone") });
    const edited = await machineA.ok(["sync"]);

    expect(edited.stdout).toContain("+ handmade");
    expect(edited.stdout).toContain("(pushed)");
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["handmade"]);
    await settled(machineA);
    await machineB.ok(["sync"]);
    expect((await globals(machineB)).handmade.id).toMatch(/my-skills\/handmade$/);
    await settled(machineB);
  });

  test("own skills edited in the repo from elsewhere reach every machine; dropped ones stop being global", async () => {
    const machineA = await world();
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    const work = (await remoteFiles(machineA, remote)).dir;

    await machineA.write(work, { "skills/review/SKILL.md": skillMd("review", "Review v1") });
    machineA.git(work, ["add", "-A"]);
    machineA.git(work, ["commit", "-q", "-m", "add review"]);
    machineA.git(work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await machineA.ok(["sync"])).stdout).toContain("+ review");
    await settled(machineA);

    await machineA.write(work, { "skills/review/SKILL.md": skillMd("review", "Review v2") });
    machineA.git(work, ["commit", "-qam", "edit"]);
    machineA.git(work, ["push", "-q", "origin", "HEAD:main"]);
    await machineA.ok(["sync"]);
    expect(await fsp.readFile(path.join((await globals(machineA)).review.path, "SKILL.md"), "utf8")).toContain("Review v2");
    await settled(machineA);

    machineA.git(work, ["rm", "-rq", "skills/review"]);
    machineA.git(work, ["commit", "-qm", "drop"]);
    machineA.git(work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await machineA.ok(["sync"])).stdout).toContain("- review");
    expect((await globals(machineA)).review).toBeUndefined();
    await settled(machineA);
  });

  test("diverged clones: manifest merged per skill, the remote wins when both changed the same skill", async () => {
    const machineA = await world();
    const up = await machineA.repo("upstream", { "skills/eps/SKILL.md": skillMd("eps", "Eps") });

    await machineA.ok(["add", up.url, "-g", "-y", "-a", "cursor"]);
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    const machineB = await machineA.machine("b");

    await machineB.ok(["sync", "init", remote]);

    const cloneB = path.join(machineB.store, "sync");
    const mB = await readJson(path.join(cloneB, "skill-library.json"));
    const id = Object.keys(mB.skills)[0]!;

    mB.skills[id].agents = ["codex"];
    await fsp.writeFile(path.join(cloneB, "skill-library.json"), `${JSON.stringify(mB, null, 2)}\n`);
    await machineB.write(cloneB, { "skills/bee/SKILL.md": skillMd("bee", "Bee") });
    machineB.git(cloneB, ["add", "-A"]);
    machineB.git(cloneB, ["commit", "-q", "-m", "local"]);

    await machineA.ok(["add", up.url, "-g", "-y", "-a", "claude-code"]);
    await machineB.ok(["sync"]);
    const files = await remoteFiles(machineB, remote);

    expect(files.manifest!.skills[id]!.agents).toEqual(["cursor", "claude-code"]);
    expect(files.skills).toEqual(["bee"]);
    expect(machineB.git(cloneB, ["log", "--format=%s", "-3"])).toContain("skill-library: merge local changes");
    await settled(machineB);
    await machineA.ok(["sync"]);
    expect(Object.keys(await globals(machineA)).sort()).toEqual(["bee", "eps"]);
    await settled(machineA);
  });
});

describe("regular commands while sync is enabled", () => {
  test("add -g / remove -g / update -g write to the repo; folder skills are machine-only unless --share", async () => {
    const machineA = await world();
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    const machineB = await machineA.machine("b");

    await machineB.ok(["sync", "init", remote]);

    // Git source → manifest entry, pushed.
    const up = await machineA.repo("upstream", { "skills/beta/SKILL.md": skillMd("beta", "Beta v1") });
    const add = await machineA.ok(["add", up.url, "-g", "-y", "-a", "codex"]);

    expect(add.stderr).toContain(`Synced to ${remote}`);
    let files = await remoteFiles(machineA, remote);

    expect(lastSegments(files.manifest)).toEqual(["beta"]);
    expect(Object.values(files.manifest!.skills)[0]).toMatchObject({ commit: up.head, agents: ["codex"] });
    await settled(machineA);

    // Folder without --share: machine-only, with a hint.
    const plainAdd = await machineA.ok(["add", await folderSkill(machineA, "draft"), "-g", "-y"]);

    expect(plainAdd.stderr).toContain("draft is machine-only (not synced). To share it: skill-library sync share draft");
    const noShare = await machineA.ok(["add", await folderSkill(machineA, "draft2"), "-g", "-y", "--no-share"]);

    expect(noShare.stderr).toContain("draft2 is machine-only");
    expect((await remoteFiles(machineA, remote)).skills).toEqual([]);
    expect((await globals(machineA)).draft.id).toMatch(/^home:\/\//);

    // Folder with --share: copied into skills/, now a repo skill.
    const shared = await machineA.ok(["add", await folderSkill(machineA, "notes", "Notes v1"), "-g", "-y", "--share"]);

    expect(shared.stderr).toContain("Shared notes across your devices");
    expect(shared.stderr).toContain(path.join(machineA.store, "sync", "skills", "notes"));
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["notes"]);
    expect((await globals(machineA)).notes.id).toMatch(/my-skills\/notes$/);
    await settled(machineA);

    // B follows.
    await machineB.ok(["sync"]);
    let gb = await globals(machineB);

    expect(Object.keys(gb).sort()).toEqual(["beta", "notes"]);
    expect(gb.beta.agents).toEqual(["Codex"]);
    await settled(machineB);

    // update -g writes the new pin.
    const v2 = await up.commit({ "skills/beta/SKILL.md": skillMd("beta", "Beta v2") });
    const upd = await machineA.ok(["update", "-g", "-y"]);

    expect(upd.stdout).toContain("Updated beta");
    expect(Object.values((await remoteFiles(machineA, remote)).manifest!.skills)[0]).toMatchObject({ commit: v2 });
    await settled(machineA);

    // remove -g drops the entry and the own folder.
    await machineA.ok(["remove", "beta", "notes", "-g", "-y"]);
    files = await remoteFiles(machineA, remote);
    expect(files.manifest!.skills).toEqual({});
    expect(files.skills).toEqual([]);
    await settled(machineA);

    // B's next global change pulls first and reports what the pull dropped.
    const memo = await machineB.ok(["add", await folderSkill(machineB, "memo"), "-g", "-y"]);

    expect(memo.stderr).toContain(`beta (dropped by ${remote})`);
    expect(memo.stderr).toContain(`notes (dropped by ${remote})`);
    gb = await globals(machineB);
    expect(Object.keys(gb)).toEqual(["memo"]);
    await settled(machineB);
  });

  test("sync share: shares one or several machine-only skills (by name or id); unknown names fail", async () => {
    const machineA = await world();
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    await machineA.ok(["add", await folderSkill(machineA, "mine"), "-g", "-y"]);
    await machineA.ok(["add", await folderSkill(machineA, "other"), "-g", "-y"]);

    const share = await machineA.ok(["sync", "share", "mine"]);

    expect(share.stdout).toContain("Shared mine");
    expect(share.stdout).toContain(`edit it here from now on: ${path.join(machineA.store, "sync", "skills", "mine")}`);
    expect(share.stdout).toContain(`Synced to ${remote}`);
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["mine"]);
    expect((await globals(machineA)).mine.id).toMatch(/my-skills\/mine$/);
    await settled(machineA);

    const again = await machineA.run(["sync", "share", "mine"]);

    expect(again.code).toBe(1);
    expect(again.stderr + again.stdout).toContain("No machine-only global skill named mine");

    const unknown = await machineA.run(["sync", "share", "nope"]);

    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("No machine-only global skill named nope");

    // Several at once, one of them by its full id.
    await machineA.ok(["add", await folderSkill(machineA, "third"), "-g", "-y"]);
    const otherId = (await globals(machineA)).other.id;
    const many = await machineA.ok(["sync", "share", otherId, "third"]);

    expect(many.stdout).toContain("Shared other");
    expect(many.stdout).toContain("Shared third");
    expect(many.stdout).not.toContain("✗");
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["mine", "other", "third"]);
    await settled(machineA);

    // A known and an unknown name: all or nothing, every name is checked before anything is shared.
    await machineA.ok(["add", await folderSkill(machineA, "fourth"), "-g", "-y"]);
    const mixed = await machineA.run(["sync", "share", "fourth", "nope"]);

    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toContain("No machine-only global skill named nope");
    expect(mixed.stdout).not.toContain("Shared");
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["mine", "other", "third"]);
    expect((await globals(machineA)).fourth.id).toMatch(/^home:\/\//);
    await settled(machineA);

    // No selectors and no TTY: nothing to pick from interactively.
    expectUsageError(await machineA.run(["sync", "share"]), "skill");
  });

  test("a skill whose name is taken replaces the old one (kept, not global); sync reports a shadowed machine-only skill", async () => {
    const machineA = await world();
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    await machineA.ok(["add", await folderSkill(machineA, "dup", "Old copy"), "-g", "-y", "--share"]);
    const ownId = (await globals(machineA)).dup.id;
    const up = await machineA.repo("upstream", { "skills/dup/SKILL.md": skillMd("dup", "Upstream") });
    const add = await machineA.ok(["add", up.url, "-g", "-y"]);

    expect(add.stdout).toContain(`Replaced dup (${ownId}; kept in the store, not global)`);
    const files = await remoteFiles(machineA, remote);

    expect(files.skills).toEqual([]);
    expect(lastSegments(files.manifest)).toEqual(["dup"]);
    const index = await validateAll(machineA);

    expect(index.skills.find((row) => row.id === ownId)).toMatchObject({ global: false });
    await validateSync(machineA, { settled: true });

    const machineB = await machineA.machine("b");

    await machineB.ok(["add", await folderSkill(machineB, "memo", "B's memo"), "-g", "-y"]);
    await machineB.ok(["sync", "init", remote]);
    await machineA.ok(["add", await folderSkill(machineA, "memo", "A's memo"), "-g", "-y", "--share"]);
    const synced = await machineB.ok(["sync"]);

    expect(synced.stdout).toContain("memo from the sync repo now shadows another global memo");
    await settled(machineB);
  });
});

describe("disable / enable / status", () => {
  test("disable keeps changes local and refuses manual syncs; enable syncs without pushing or dropping them", async () => {
    const machineA = await world();
    const remote = await machineA.emptyRemote("my-skills");
    const up0 = await machineA.repo("upstream0", { "SKILL.md": skillMd("kept", "Kept skill") });

    await machineA.ok(["add", up0.url, "-g", "-y"]);
    await machineA.ok(["sync", "init", remote]);

    const disabled = await machineA.ok(["sync", "disable"]);

    expect(disabled.stdout).toContain(`Sync disabled. Nothing is pulled from or pushed to ${remote}`);
    expect((await readJson(path.join(machineA.store, "sync.json"))).enabled).toBe(false);
    await validateSync(machineA);

    const up = await machineA.repo("upstream", { "skills/delta/SKILL.md": skillMd("delta", "Delta") });
    const add = await machineA.ok(["add", up.url, "-g", "-y"]);

    expect(add.stderr).not.toContain("Synced");
    await machineA.ok(["remove", "kept", "-g", "-y"]);
    expect(lastSegments((await remoteFiles(machineA, remote)).manifest)).toEqual(["kept"]);
    await validateAll(machineA);

    const refused = await machineA.run(["sync"]);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("sync is disabled — run skill-library sync enable");
    expect((await machineA.ok(["sync", "status"])).stdout).toMatch(/Sync:\s+disabled/);
    expect((await readJson(path.join(machineA.store, "sync.json"))).enabled).toBe(false);

    const enabled = await machineA.ok(["sync", "enable"]);

    expect(enabled.stdout).toContain("Sync enabled");
    expect((await readJson(path.join(machineA.store, "sync.json"))).enabled).toBe(true);
    // delta stays local-only; the repo still lists kept, so the sync brings it back.
    expect(lastSegments((await remoteFiles(machineA, remote)).manifest)).toEqual(["kept"]);
    const tracked = await globals(machineA);

    expect(tracked.delta).toBeDefined();
    expect(tracked.kept).toBeDefined();
    await settled(machineA);
  });

  test("status: not set up, set up, and pending commits + lastError after a failed push (cleared once pushed)", async () => {
    const machineA = await world();

    expect((await machineA.ok(["sync", "status"])).stdout).toBe("Sync is not set up. Run skill-library sync init <git-url>\n");
    expect(await exists(path.join(machineA.store, "sync.json"))).toBe(false);

    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    const text = (await machineA.ok(["sync", "status"])).stdout;

    expect(text).toContain(`Repository: ${remote}`);
    expect(text).toMatch(/Sync:\s+enabled/);
    expect(text).toContain(`Clone:      ${path.join(machineA.store, "sync")}`);
    expect(text).toMatch(/Last sync:\s+\S/);
    expect(text).not.toContain("never");
    expect(text).not.toContain("Unpushed");
    expect(Date.parse((await readJson(path.join(machineA.store, "sync-status.json"))).lastSync)).not.toBeNaN();

    // The remote disappears: a global add commits locally and reports the failed push.
    const bare = bareOf(remote);

    await fsp.rename(bare, `${bare}.gone`);
    const up = await machineA.repo("upstream", { "SKILL.md": skillMd("solo", "Solo") });
    const add = await machineA.ok(["add", up.url, "-g", "-y"]);

    expect(add.stderr).toContain("sync:");
    expect(add.stderr).toContain("pushed on the next sync");
    const failed = await machineA.run(["sync"]);

    expect(failed.code).not.toBe(0);
    expect(typeof (await readJson(path.join(machineA.store, "sync-status.json"))).lastError).toBe("string");
    expect(Number(machineA.git(path.join(machineA.store, "sync"), ["rev-list", "--count", "@{u}..HEAD"]))).toBeGreaterThanOrEqual(1);
    const pendText = (await machineA.ok(["sync", "status"])).stdout;

    expect(pendText).toMatch(/Unpushed:\s+\d+ commit\(s\)/);
    expect(pendText).toContain("Last error:");
    await validateAll(machineA);

    // Back again: the next sync pushes the kept commit.
    await fsp.rename(`${bare}.gone`, bare);
    await machineA.ok(["sync"]);
    const afterText = (await machineA.ok(["sync", "status"])).stdout;

    expect(afterText).not.toContain("Unpushed");
    expect(afterText).not.toContain("Last error");
    expect((await readJson(path.join(machineA.store, "sync-status.json"))).lastError ?? null).toBeNull();
    expect(lastSegments((await remoteFiles(machineA, remote)).manifest)).toEqual(["solo"]);
    await settled(machineA);
  });
});

describe("sync update", () => {
  test("moves history, manifest and own skills to a new repo; own skills get new ids; later changes go there", async () => {
    const machineA = await world();
    const up = await machineA.repo("upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha") });

    await machineA.ok(["add", up.url, "-g", "-y"]);
    await machineA.ok(["add", await folderSkill(machineA, "mine"), "-g", "-y"]);
    const oldRemote = await machineA.emptyRemote("old-skills");

    await machineA.ok(["sync", "init", oldRemote, "--share", "mine"]);
    const oldHead = machineA.git(path.join(machineA.store, "sync"), ["rev-parse", "HEAD"]);
    const machineB = await machineA.machine("b");

    await machineB.ok(["sync", "init", oldRemote]);
    const up2 = await machineB.repo("upstream2", { "skills/beta/SKILL.md": skillMd("beta", "Beta") });

    await machineB.ok(["add", up2.url, "-g", "-y"]);

    const newRemote = await machineA.emptyRemote("new-skills");
    const move = await machineA.ok(["sync", "update", newRemote]);

    expect(move.stdout).toContain(`Sync moved from ${oldRemote} to ${newRemote}`);
    expect(move.stdout).toContain("+ beta");
    // The README init wrote for the old URL, unchanged, is replaced without asking.
    expect(move.stdout).toContain("Replaced the repository's README.md.");
    expect(move.stdout).toContain(`On your other machines, run skill-library sync update ${newRemote}`);
    expect(move.stdout).not.toMatch(/[+-] mine/);
    await settled(machineA);

    const files = await remoteFiles(machineA, newRemote);

    expect(lastSegments(files.manifest)).toEqual(["alpha", "beta"]);
    expect(files.skills).toEqual(["mine"]);
    expect(await fsp.readFile(path.join(files.dir, "README.md"), "utf8")).toContain(`sync init ${newRemote}`);
    // Full history moved (the old head is an ancestor).
    machineA.git(files.dir, ["merge-base", "--is-ancestor", oldHead, "HEAD"]);

    const ga = await globals(machineA);

    expect(Object.keys(ga).sort()).toEqual(["alpha", "beta", "mine"]);
    expect(ga.mine.id).toMatch(/new-skills\/mine$/);
    const index = await readJson(path.join(machineA.store, "index.json"));

    expect(index.skills.filter((row: any) => row.id.endsWith("/mine")).map((row: any) => row.id)).toEqual([ga.mine.id]);

    await machineA.ok(["add", await folderSkill(machineA, "other"), "-g", "-y", "--share"]);
    expect((await remoteFiles(machineA, newRemote)).skills).toEqual(["mine", "other"]);
    expect((await remoteFiles(machineA, oldRemote)).skills).toEqual(["mine"]);
    await settled(machineA);

    // B keeps using the old repo until it moves too.
    const bMove = await machineB.ok(["sync", "update", newRemote]);

    expect(bMove.stdout).toContain(`Sync moved from ${oldRemote} to ${newRemote}`);
    expect(Object.keys(await globals(machineB)).sort()).toEqual(["alpha", "beta", "mine", "other"]);
    await settled(machineB);

    const same = await machineA.ok(["sync", "update", newRemote]);

    expect(same.stdout).toContain(`Sync already uses ${newRemote}`);
    expect(same.stderr).toBe("");
  });

  test("--no-readme, a gone old repo, unrelated history, missing URL, not set up", async () => {
    const machineA = await world();
    const notSetUp = await machineA.run(["sync", "update", "file:///nowhere.git"]);

    expect(notSetUp.code).toBe(1);
    expect(notSetUp.stderr).toContain("sync init");
    expectUsageError(await machineA.run(["sync", "update"]), "git-url", "url");

    await machineA.ok(["add", await folderSkill(machineA, "mine"), "-g", "-y"]);
    const first = await machineA.emptyRemote("first");

    await machineA.ok(["sync", "init", first, "--share", "*"]);

    const unrelated = await machineA.repo("unrelated", { "README.md": "hello\n" });
    const refused = await machineA.run(["sync", "update", unrelated.url]);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("unrelated history");
    expect((await readJson(path.join(machineA.store, "sync.json"))).url).toBe(first);
    expect(await fsp.readFile(path.join((await remoteFiles(machineA, unrelated.url)).dir, "README.md"), "utf8")).toBe("hello\n");
    await machineA.ok(["sync"]);
    await settled(machineA);

    const second = await machineA.emptyRemote("second");
    const updated = await machineA.ok(["sync", "update", second, "--no-readme"]);

    expect(updated.stdout).toContain(`Sync moved from ${first} to ${second}`);
    expect(updated.stdout).not.toContain("README");
    expect((await readJson(path.join(machineA.store, "sync.json"))).url).toBe(second);
    const files = await remoteFiles(machineA, second);

    expect(files.skills).toEqual(["mine"]);
    // --no-readme: the README init wrote for the first URL is moved as it is, not rewritten.
    expect(await fsp.readFile(path.join(files.dir, "README.md"), "utf8")).toContain(`sync init ${first}`);
    await settled(machineA);

    // The old repository is gone: update says so and moves the clone as it is.
    await fsp.rm(bareOf(second), { recursive: true, force: true });
    const third = await machineA.emptyRemote("third");
    const moved = await machineA.ok(["sync", "update", third]);

    expect(moved.stderr).toContain(`Could not pull from ${second}`);
    expect((await remoteFiles(machineA, third)).skills).toEqual(["mine"]);
    expect((await globals(machineA)).mine.id).toMatch(/third\/mine$/);
    await settled(machineA);
  });
});

describe("background sync", () => {
  test("sync --background exits 0 silently and records its result", async () => {
    const machineA = await world();
    // Not set up: still silent and successful.
    const quiet = await machineA.run(["sync", "--background"]);

    expect(quiet).toMatchObject({ code: 0, stdout: "", stderr: "" });

    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    const before = (await readJson(path.join(machineA.store, "sync-status.json"))).lastSync;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const bg = await machineA.run(["sync", "--background"]);

    expect(bg).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const status = await readJson(path.join(machineA.store, "sync-status.json"));

    expect(Date.parse(status.lastSync)).toBeGreaterThan(Date.parse(before));
    await settled(machineA);

    // A failing background run is silent too, and leaves the error in the status file.
    await fsp.rename(bareOf(remote), `${bareOf(remote)}.gone`);
    const failing = await machineA.run(["sync", "--background"]);

    expect(failing).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(typeof (await readJson(path.join(machineA.store, "sync-status.json"))).lastError).toBe("string");
  });

  test("query starts a background sync after the TTL; its changes are reported once, then cleared", async () => {
    const ts = await fakeTypeSafe();

    try {
      const env = { SKILL_LIBRARY_TYPESAFE_API_KEY: "k", SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url };
      const machineA = await world({ env });
      const remote = await machineA.emptyRemote("my-skills");

      await machineA.ok(["sync", "init", remote]);
      const machineB = await machineA.machine("b");

      await machineB.ok(["sync", "init", remote]);
      await machineB.ok(["add", await folderSkill(machineB, "zeta", "Zeta helps with zebra stripes"), "-g", "-y", "--share"]);

      // Within the TTL (the harness default) nothing starts.
      const lastAttempt = async () => (await readJson(path.join(machineA.store, "sync-status.json"))).lastAttempt;
      const t0 = await lastAttempt();

      await machineA.ok(["query", "anything at all"]);
      expect(await lastAttempt()).toBe(t0);

      const first = await machineA.ok(["query", "zebra stripes"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });

      expect(first.stdout).not.toContain("Your skills changed");
      const zeta = await until(async () => (await globals(machineA)).zeta);

      expect(zeta, "background sync brought in zeta").toBeDefined();
      const status = await until(async () => (await readJson(path.join(machineA.store, "sync-status.json"))).unreported);

      expect(status).toEqual({ added: ["zeta"], removed: [], updated: [] });
      await settled(machineA);

      // The next successful query reports it (text), once.
      const told = await machineA.ok(["query", "zebra stripes"]);

      expect(told.stdout).toContain("zeta (92%)");
      expect(told.stdout).toContain("Your skills changed — tell the user:\n  added: zeta");
      const again = await machineA.ok(["query", "zebra stripes"]);

      expect(again.stdout).not.toContain("Your skills changed");

      // And in --json as syncChanges, after another background run that drops it.
      await machineB.ok(["remove", "zeta", "-g", "-y"]);
      await machineA.ok(["query", "x y z w"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
      await until(async () => (await readJson(path.join(machineA.store, "sync-status.json"))).unreported);
      const json = (await machineA.ok(["query", "zebra stripes", "--json"])).json();

      expect(json.syncChanges).toEqual({ added: [], removed: ["zeta"], updated: [] });
      expect((await machineA.ok(["query", "zebra stripes", "--json"])).json().syncChanges).toBeUndefined();
      await settled(machineA, machineB);
    } finally {
      await ts.close();
    }
  });
});

describe("background sync: disabled and failing", () => {
  test("query starts no background sync while sync is disabled; after a failed one it tells the agent once, without details", async () => {
    const machineA = await world();
    const ts = await fakeTypeSafe();

    try {
      machineA.env.SKILL_LIBRARY_TYPESAFE_API_BASE = ts.url;
      machineA.env.SKILL_LIBRARY_TYPESAFE_API_KEY = "k";
      const remote = await machineA.emptyRemote("my-skills");

      await machineA.ok(["sync", "init", remote]);
      const statusFile = path.join(machineA.store, "sync-status.json");
      const attempt = async () => (await readJson(statusFile)).lastAttempt as string;

      // Disabled: even with the TTL at 0, query leaves sync alone.
      await machineA.ok(["sync", "disable"]);
      const before = await attempt();
      const quiet = await machineA.ok(["query", "anything at all"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });

      expect(quiet.stderr).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await attempt()).toBe(before);

      // Enabled, remote gone: the background run fails and records it.
      await machineA.ok(["sync", "enable"]);
      const bare = bareOf(remote);

      await fsp.rename(bare, `${bare}.gone`);
      const started = await attempt();

      await machineA.ok(["query", "anything at all"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
      await until(async () => {
        const st = await readJson(statusFile);

        return st.lastAttempt !== started && typeof st.lastError === "string" ? st : null;
      });
      // The next query that starts one prints a single line, naming no error text, path or URL.
      const told = await machineA.ok(["query", "anything at all"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
      const lines = told.stderr.split("\n").filter(Boolean);

      expect(lines).toEqual(["skill-library: updating your skills failed last time — the user can run skill-library sync status for details"]);
      expect(told.stderr).not.toContain(remote);
      expect(told.stderr).not.toContain(machineA.store);
      // Within the TTL, nothing is started and nothing is printed.
      expect((await machineA.ok(["query", "anything at all"])).stderr).toBe("");
      await fsp.rename(`${bare}.gone`, bare);
      await until(async () => !(await fsp.readdir(path.join(machineA.store)).then((names) => names.includes("sync.lock"))));
    } finally {
      await ts.close();
    }
  });
});

describe("usage errors", () => {
  test("before setup, every subcommand but init/status says how to set it up and creates nothing", async () => {
    const machineA = await world();

    await machineA.ok(["add", await folderSkill(machineA, "mine"), "-g", "-y"]); // the library exists, sync doesn't

    for (const args of [["sync"], ["sync", "enable"], ["sync", "disable"], ["sync", "share", "x"], ["sync", "update", "file:///x.git"]]) {
      const result = await machineA.run(args);

      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("Sync is not set up.");
      expect(result.stderr).toContain("Run skill-library sync init <git-url>");
    }

    expect(await exists(path.join(machineA.store, "sync.json"))).toBe(false);
    expect(await exists(path.join(machineA.store, "sync"))).toBe(false);
  });

  test("before setup on a fresh machine (no library folder), enable/disable say how to set it up", async () => {
    const machineA = await world();

    for (const sub of ["enable", "disable"]) {
      const result = await machineA.run(["sync", sub]);

      expect(result.code, sub).toBe(1);
      expect(result.stderr).toContain("Sync is not set up.");
    }
  });

  test("while disabled, share and update refuse; enable and disable are idempotent", async () => {
    const machineA = await world();
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    await machineA.ok(["add", await folderSkill(machineA, "mine"), "-g", "-y"]);
    await machineA.ok(["sync", "disable"]);
    await machineA.ok(["sync", "disable"]);
    expect((await readJson(path.join(machineA.store, "sync.json"))).enabled).toBe(false);
    const share = await machineA.run(["sync", "share", "mine"]);

    expect(share.code).toBe(1);
    expect(share.stderr).toContain("sync is disabled — run skill-library sync enable");
    const next = await machineA.emptyRemote("next");
    const update = await machineA.run(["sync", "update", next]);

    expect(update.code).toBe(1);
    expect(update.stderr).toContain("sync is disabled — run skill-library sync enable first");
    expect((await readJson(path.join(machineA.store, "sync.json"))).url).toBe(remote);
    expect((await remoteFiles(machineA, remote)).skills).toEqual([]);
    await machineA.ok(["sync", "enable"]);
    const again = await machineA.ok(["sync", "enable"]);

    expect(again.stdout).toContain("Sync enabled");
    expect(again.stdout).toContain(`Global skills are in sync with ${remote}`);
    await settled(machineA);
  });

  test("--share is only an option of init: anywhere else it is an unknown option and shares nothing", async () => {
    const machineA = await world();
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    await machineA.ok(["add", await folderSkill(machineA, "mine"), "-g", "-y"]);

    // Plain sync (sync now) and the other subcommands don't take it: it is named, as an unknown
    // option warned about or rejected.
    for (const args of [["sync", "--share", "mine"], ["sync", "status", "--share", "mine"], ["sync", "update", remote, "--share", "mine"]]) {
      expectUnknownOption(await machineA.run(args), "--share");
    }

    expect((await remoteFiles(machineA, remote)).skills).toEqual([]);
    expect((await globals(machineA)).mine.id).toMatch(/^home:\/\//);
    await settled(machineA);
  });

  test("--json is not a sync option: every subcommand either rejects it, or warns once and behaves exactly as without it", async () => {
    const machineA = await world();
    const probe = await machineA.run(["sync", "status", "--json"]);

    if (!expectUnknownOption(probe, "--json")) {
      // Rejected: a usage error on every subcommand, and nothing is set up.
      const remote = await machineA.emptyRemote("my-skills");

      for (const args of [["status"], ["init", remote], [], ["share", "x"], ["disable"], ["enable"], ["update", remote]]) {
        expectUsageError(await machineA.run(["sync", ...args, "--json"]), "--json");
      }

      expect(await exists(path.join(machineA.store, "sync.json"))).toBe(false);
      expect(await remoteFiles(machineA, remote).then((peek) => peek.files)).toEqual([]);

      return;
    }

    const unknown = (output: { stdout: string; stderr: string }) => (output.stdout + output.stderr).split("\n").filter((line) => line.includes("--json"));
    const st = await machineA.ok(["sync", "status", "--json"]);

    expect(unknown(st)).toHaveLength(1);
    expect(st.stdout).toBe("Sync is not set up. Run skill-library sync init <git-url>\n");

    const remote = await machineA.emptyRemote("my-skills");
    const init = await machineA.ok(["sync", "init", remote, "--json"]);

    expect(unknown(init)).toHaveLength(1);
    expect(init.stdout).toContain(`with ${remote} (pushed)`);
    expect(() => JSON.parse(init.stdout)).toThrow();
    await settled(machineA);

    const sync = await machineA.ok(["sync", "--json"]);

    expect(unknown(sync)).toHaveLength(1);
    expect(sync.stdout).toBe(`Global skills are in sync with ${remote}\n`);

    expect((await machineA.ok(["sync", "status", "--json"])).stdout).toContain(`Repository: ${remote}`);

    await machineA.ok(["add", await folderSkill(machineA, "mine"), "-g", "-y"]);
    const share = await machineA.ok(["sync", "share", "mine", "--json"]);

    expect(unknown(share)).toHaveLength(1);
    expect(share.stdout).toContain("Shared mine");
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["mine"]);

    const failing = await machineA.run(["sync", "share", "nope", "--json"]);

    expect(failing.code).toBe(1);
    expect(failing.stdout + failing.stderr).toContain("No machine-only global skill named nope");

    const disable = await machineA.ok(["sync", "disable", "--json"]);

    expect(unknown(disable)).toHaveLength(1);
    expect(disable.stdout).toContain("Sync disabled.");
    const enable = await machineA.ok(["sync", "enable", "--json"]);

    expect(unknown(enable)).toHaveLength(1);
    expect(enable.stdout).toContain("Sync enabled");

    const next = await machineA.emptyRemote("next");
    const update = await machineA.ok(["sync", "update", next, "--json"]);

    expect(unknown(update)).toHaveLength(1);
    expect(update.stdout).toContain(`Sync moved from ${remote} to ${next}`);
    await settled(machineA);
  });

  test("an unknown sync command and --share without a value are usage errors", async () => {
    const testWorld = await world();

    expectUsageError(await testWorld.run(["sync", "frobnicate"]), "frobnicate");
    expectUsageError(await testWorld.run(["sync", "--share"]), "--share");
    expect(await exists(testWorld.store)).toBe(false);
  });
});
