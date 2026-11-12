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
async function globals(w: World): Promise<Record<string, any>> {
  const rows = (await w.ok(["list", "-g", "--json"], { cwd: w.home })).json() as any[];
  return Object.fromEntries(rows.filter((r) => r.status === "tracked").map((r) => [r.name, r]));
}

/** Library + sync state are consistent and settled (nothing uncommitted or unpushed). */
async function settled(...ws: World[]): Promise<void> {
  for (const w of ws) {
    await validateAll(w);
    await validateSync(w, { settled: true });
  }
}

/** A folder skill under the machine's HOME (home:// id). */
async function folderSkill(w: World, name: string, description = `${name} skill`): Promise<string> {
  const dir = path.join(w.home, "skills-src", name);
  await w.write(dir, { "SKILL.md": skillMd(name, description) });
  return dir;
}

const lastSegments = (m: any) => Object.keys(m?.skills ?? {}).map((id) => id.split("/").pop()).sort();
const bareOf = (url: string) => url.replace(/^file:\/\//, "");

/** Wait (bounded) until `check` holds; returns its last value. */
async function until<T>(check: () => Promise<T>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  let v = await check();
  while (!v && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    v = await check();
  }
  return v;
}

describe("sync init", () => {
  test("seeds an empty repo with global git skills and a README; folder skills stay machine-only without a TTY", async () => {
    const a = await world();
    const up = await a.repo("upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha skill"), "skills/beta/SKILL.md": skillMd("beta", "Beta skill") });
    await a.ok(["add", up.url, "-g", "-y"]);
    await a.ok(["add", await folderSkill(a, "copy"), "-g", "-y"]);
    const remote = await a.emptyRemote("my-skills");

    const init = await a.ok(["sync", "init", remote]);
    expect(init.stdout).toContain("The repository was empty; added this machine's 2 global skill(s) to it.");
    expect(init.stdout).toContain("Kept machine-only (not synced): copy");
    expect(init.stdout).toContain("Share one with skill-library sync share <name>");
    expect(init.stdout).toContain("Added the repository's README.md.");
    expect(init.stdout).toContain(`with ${remote} (pushed)`);
    expect(init.stdout).toContain("Sync runs on its own from now on");
    await settled(a);

    const files = await remoteFiles(a, remote);
    expect(lastSegments(files.manifest)).toEqual(["alpha", "beta"]);
    for (const e of Object.values(files.manifest!.skills)) expect(e).toMatchObject({ source: up.url, commit: up.head, ref: null });
    expect(Object.values(files.manifest!.skills).map((e) => e.path).sort()).toEqual(["skills/alpha", "skills/beta"]);
    expect(files.skills).toEqual([]);
    expect(files.files).toEqual(["README.md", "skill-library.json"]);
    const readme = await fsp.readFile(path.join(files.dir, "README.md"), "utf8");
    expect(readme).toContain("Skill Library");
    expect(readme).toContain(`skill-library sync init ${remote}`);
    expect(readme).not.toContain("{{");

    const cfg = await readJson(path.join(a.store, "sync.json"));
    expect(cfg.url).toBe(remote);
    expect(cfg.enabled).toBe(true);
    const g = await globals(a);
    expect(Object.keys(g).sort()).toEqual(["alpha", "beta", "copy"]);
    expect(g.copy.id).toMatch(/^home:\/\//);
  });

  test("--share picks folder skills by name, several names, '*', or full id; --share without a value fails", async () => {
    const a = await world();
    for (const n of ["one", "two", "three"]) await a.ok(["add", await folderSkill(a, n), "-g", "-y"]);
    const ids = Object.fromEntries(Object.entries(await globals(a)).map(([n, r]) => [n, r.id as string]));

    expectUsageError(await a.run(["sync", "init", await a.emptyRemote("x"), "--share"]), "--share");
    expect(await exists(path.join(a.store, "sync.json"))).toBe(false);

    const byName = await a.emptyRemote("by-name");
    await a.ok(["sync", "init", byName, "--share", "one"]);
    expect((await remoteFiles(a, byName)).skills).toEqual(["one"]);
    await settled(a);

    // Several names / '*' / full id: each on a fresh machine with the same folder skills.
    const cases: [string, string[], string[]][] = [
      ["several", ["one", "two"], ["one", "two"]],
      ["star", ["*"], ["one", "three", "two"]],
      ["by-id", [ids.three!], ["three"]],
    ];
    for (const [name, share, want] of cases) {
      const m = await a.machine(name);
      for (const n of ["one", "two", "three"]) await m.ok(["add", await folderSkill(m, n), "-g", "-y"]);
      const remote = await m.emptyRemote(`share-${name}`);
      const share2 = share[0] === ids.three ? [(await globals(m)).three.id] : share;
      const r = await m.ok(["sync", "init", remote, "--share", ...share2]);
      expect((await remoteFiles(m, remote)).skills, name).toEqual(want);
      const notShared = ["one", "two", "three"].filter((n) => !want.includes(n));
      if (notShared.length > 0) expect(r.stdout).toContain(`Kept machine-only (not synced): ${notShared.sort().join(", ")}`);
      else expect(r.stdout).not.toContain("Kept machine-only");
      const g = await globals(m);
      for (const n of want) expect(g[n].id, n).toMatch(new RegExp(`share-${name}/${n}$`));
      for (const n of notShared) expect(g[n].id, n).toMatch(/^home:\/\//);
      await settled(m);
    }
  });

  test("--no-readme, an existing README is kept without a TTY; seeding reports seeded and machine-only skills; init again is a no-op", async () => {
    const a = await world();
    const bare = await a.emptyRemote("no-readme");
    await a.ok(["sync", "init", bare, "--no-readme"]);
    expect((await remoteFiles(a, bare)).files).not.toContain("README.md");
    await settled(a);

    const b = await a.machine("b");
    const has = await b.repo("has-readme", { "README.md": "# Mine\n" });
    const kept = await b.ok(["sync", "init", has.url]);
    expect(kept.stdout).not.toContain("README");
    expect(await fsp.readFile(path.join((await remoteFiles(b, has.url)).dir, "README.md"), "utf8")).toBe("# Mine\n");
    await settled(b);

    const c = await a.machine("c");
    const up = await c.repo("upstream-c", { "SKILL.md": skillMd("solo", "Solo skill") });
    await c.ok(["add", up.url, "-g", "-y"]);
    await c.ok(["add", await folderSkill(c, "local-one"), "-g", "-y"]);
    const remote = await c.emptyRemote("seeded");
    const r = await c.ok(["sync", "init", remote]);
    expect(r.stdout).toContain("The repository was empty; added this machine's 1 global skill(s) to it.");
    expect(r.stdout).toContain("Kept machine-only (not synced): local-one");
    expect(r.stdout).toContain("Added the repository's README.md.");
    expect(r.stdout).toContain(`with ${remote} (pushed)`);
    expect(r.stdout).not.toContain("✗");
    const seeded = await remoteFiles(c, remote);
    expect(lastSegments(seeded.manifest)).toEqual(["solo"]);
    expect(seeded.skills).toEqual([]);
    expect(seeded.files).toEqual(["README.md", "skill-library.json"]);
    expect((await readJson(path.join(c.store, "sync.json"))).url).toBe(remote);
    await settled(c);

    // Again with the same URL: already set up, nothing changes.
    const head = c.git(path.join(c.store, "sync"), ["rev-parse", "HEAD"]);
    const text = await c.ok(["sync", "init", remote]);
    expect(text.stdout).toContain(`Sync is already set up with ${remote}`);
    expect(text.stderr).toBe("");
    expect(c.git(path.join(c.store, "sync"), ["rev-parse", "HEAD"])).toBe(head);
  });

  test("errors: missing URL, a different URL, an unreachable URL (nothing left behind)", async () => {
    const a = await world();
    const none = await a.run(["sync", "init"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("Missing required argument: git-url");

    const bad = await a.run(["sync", "init", "file:///nonexistent/repo.git"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Failed to clone file:///nonexistent/repo.git");
    expect(await exists(path.join(a.store, "sync.json"))).toBe(false);
    expect(await exists(path.join(a.store, "sync"))).toBe(false);
    expect((await a.ok(["sync", "status"])).stdout).toContain("Sync is not set up. Run skill-library sync init <git-url>");
    const manual = await a.run(["sync"]);
    expect(manual.code).not.toBe(0);
    expect(manual.stderr).toContain("skill-library sync init <git-url>");

    const remote = await a.emptyRemote("first");
    await a.ok(["sync", "init", remote]);
    const other = await a.run(["sync", "init", await a.emptyRemote("second")]);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("already set up");
    expect(other.stderr).toContain("sync update");
    expect((await readJson(path.join(a.store, "sync.json"))).url).toBe(remote);
    await settled(a);
  });

  test("a second machine gets the same global skills: git skills at their pinned commits, own skills under repo:// ids", async () => {
    const a = await world();
    const up = await a.repo("upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha skill") });
    await a.ok(["add", up.url, "-g", "-y", "-a", "codex"]);
    await a.ok(["add", await folderSkill(a, "mine", "My own skill"), "-g", "-y"]);
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote, "--share", "mine"]);
    // Upstream moves on after the pin: B must still get the pinned commit at init.
    const pinned = up.head;

    const b = await a.machine("b");
    const init = await b.ok(["sync", "init", remote]);
    expect(init.stdout).toContain("+ alpha");
    expect(init.stdout).toContain("+ mine");
    await settled(a, b);
    const ga = await globals(a);
    const gb = await globals(b);
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
    const a = await world();
    const up = await a.repo("upstream", { "skills/gamma/SKILL.md": skillMd("gamma", "Gamma v1") });
    await a.ok(["add", up.url, "-g", "-y"]);
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    const b = await a.machine("b");
    await b.ok(["sync", "init", remote]);

    const quiet = await a.ok(["sync"]);
    expect(quiet.stdout).toBe(`Global skills are in sync with ${remote}\n`);
    const lastSync = (await readJson(path.join(a.store, "sync-status.json"))).lastSync;
    expect(Date.parse(lastSync)).not.toBeNaN();

    const v2 = await up.commit({ "skills/gamma/SKILL.md": skillMd("gamma", "Gamma v2") });
    const s = await a.ok(["sync"]);
    expect(s.stdout).toContain("↑ gamma");
    expect(s.stdout).toContain(`Synced global skills with ${remote} (pushed)`);
    expect(s.stdout).not.toMatch(/^\s+[+-] /m);
    expect(Object.values((await remoteFiles(a, remote)).manifest!.skills)[0]).toMatchObject({ commit: v2 });
    await settled(a);

    await b.ok(["sync"]);
    expect((await globals(b)).gamma.path).toContain(v2.slice(0, 12));
    await settled(b);

    // An edit made directly in A's clone is committed and pushed by the next sync.
    const clone = path.join(a.store, "sync");
    await a.write(clone, { "skills/handmade/SKILL.md": skillMd("handmade", "Made in the clone") });
    const edited = await a.ok(["sync"]);
    expect(edited.stdout).toContain("+ handmade");
    expect(edited.stdout).toContain("(pushed)");
    expect((await remoteFiles(a, remote)).skills).toEqual(["handmade"]);
    await settled(a);
    await b.ok(["sync"]);
    expect((await globals(b)).handmade.id).toMatch(/my-skills\/handmade$/);
    await settled(b);
  });

  test("own skills edited in the repo from elsewhere reach every machine; dropped ones stop being global", async () => {
    const a = await world();
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    const work = (await remoteFiles(a, remote)).dir;
    await a.write(work, { "skills/review/SKILL.md": skillMd("review", "Review v1") });
    a.git(work, ["add", "-A"]);
    a.git(work, ["commit", "-q", "-m", "add review"]);
    a.git(work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await a.ok(["sync"])).stdout).toContain("+ review");
    await settled(a);

    await a.write(work, { "skills/review/SKILL.md": skillMd("review", "Review v2") });
    a.git(work, ["commit", "-qam", "edit"]);
    a.git(work, ["push", "-q", "origin", "HEAD:main"]);
    await a.ok(["sync"]);
    expect(await fsp.readFile(path.join((await globals(a)).review.path, "SKILL.md"), "utf8")).toContain("Review v2");
    await settled(a);

    a.git(work, ["rm", "-rq", "skills/review"]);
    a.git(work, ["commit", "-qm", "drop"]);
    a.git(work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await a.ok(["sync"])).stdout).toContain("- review");
    expect((await globals(a)).review).toBeUndefined();
    await settled(a);
  });

  test("diverged clones: manifest merged per skill, the remote wins when both changed the same skill", async () => {
    const a = await world();
    const up = await a.repo("upstream", { "skills/eps/SKILL.md": skillMd("eps", "Eps") });
    await a.ok(["add", up.url, "-g", "-y", "-a", "cursor"]);
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    const b = await a.machine("b");
    await b.ok(["sync", "init", remote]);

    const cloneB = path.join(b.store, "sync");
    const mB = await readJson(path.join(cloneB, "skill-library.json"));
    const id = Object.keys(mB.skills)[0]!;
    mB.skills[id].agents = ["codex"];
    await fsp.writeFile(path.join(cloneB, "skill-library.json"), `${JSON.stringify(mB, null, 2)}\n`);
    await b.write(cloneB, { "skills/bee/SKILL.md": skillMd("bee", "Bee") });
    b.git(cloneB, ["add", "-A"]);
    b.git(cloneB, ["commit", "-q", "-m", "local"]);

    await a.ok(["add", up.url, "-g", "-y", "-a", "claude-code"]);
    await b.ok(["sync"]);
    const files = await remoteFiles(b, remote);
    expect(files.manifest!.skills[id]!.agents).toEqual(["cursor", "claude-code"]);
    expect(files.skills).toEqual(["bee"]);
    expect(b.git(cloneB, ["log", "--format=%s", "-3"])).toContain("skill-library: merge local changes");
    await settled(b);
    await a.ok(["sync"]);
    expect(Object.keys(await globals(a)).sort()).toEqual(["bee", "eps"]);
    await settled(a);
  });
});

describe("regular commands while sync is enabled", () => {
  test("add -g / remove -g / update -g write to the repo; folder skills are machine-only unless --share", async () => {
    const a = await world();
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    const b = await a.machine("b");
    await b.ok(["sync", "init", remote]);

    // Git source → manifest entry, pushed.
    const up = await a.repo("upstream", { "skills/beta/SKILL.md": skillMd("beta", "Beta v1") });
    const add = await a.ok(["add", up.url, "-g", "-y", "-a", "codex"]);
    expect(add.stderr).toContain(`Synced to ${remote}`);
    let files = await remoteFiles(a, remote);
    expect(lastSegments(files.manifest)).toEqual(["beta"]);
    expect(Object.values(files.manifest!.skills)[0]).toMatchObject({ commit: up.head, agents: ["codex"] });
    await settled(a);

    // Folder without --share: machine-only, with a hint.
    const plainAdd = await a.ok(["add", await folderSkill(a, "draft"), "-g", "-y"]);
    expect(plainAdd.stderr).toContain("draft is machine-only (not synced). To share it: skill-library sync share draft");
    const noShare = await a.ok(["add", await folderSkill(a, "draft2"), "-g", "-y", "--no-share"]);
    expect(noShare.stderr).toContain("draft2 is machine-only");
    expect((await remoteFiles(a, remote)).skills).toEqual([]);
    expect((await globals(a)).draft.id).toMatch(/^home:\/\//);

    // Folder with --share: copied into skills/, now a repo skill.
    const shared = await a.ok(["add", await folderSkill(a, "notes", "Notes v1"), "-g", "-y", "--share"]);
    expect(shared.stderr).toContain("Shared notes across your devices");
    expect(shared.stderr).toContain(path.join(a.store, "sync", "skills", "notes"));
    expect((await remoteFiles(a, remote)).skills).toEqual(["notes"]);
    expect((await globals(a)).notes.id).toMatch(/my-skills\/notes$/);
    await settled(a);

    // B follows.
    await b.ok(["sync"]);
    let gb = await globals(b);
    expect(Object.keys(gb).sort()).toEqual(["beta", "notes"]);
    expect(gb.beta.agents).toEqual(["Codex"]);
    await settled(b);

    // update -g writes the new pin.
    const v2 = await up.commit({ "skills/beta/SKILL.md": skillMd("beta", "Beta v2") });
    const upd = await a.ok(["update", "-g", "-y"]);
    expect(upd.stdout).toContain("Updated beta");
    expect(Object.values((await remoteFiles(a, remote)).manifest!.skills)[0]).toMatchObject({ commit: v2 });
    await settled(a);

    // remove -g drops the entry and the own folder.
    await a.ok(["remove", "beta", "notes", "-g", "-y"]);
    files = await remoteFiles(a, remote);
    expect(files.manifest!.skills).toEqual({});
    expect(files.skills).toEqual([]);
    await settled(a);

    // B's next global change pulls first and reports what the pull dropped.
    const memo = await b.ok(["add", await folderSkill(b, "memo"), "-g", "-y"]);
    expect(memo.stderr).toContain(`beta (dropped by ${remote})`);
    expect(memo.stderr).toContain(`notes (dropped by ${remote})`);
    gb = await globals(b);
    expect(Object.keys(gb)).toEqual(["memo"]);
    await settled(b);
  });

  test("sync share: shares one or several machine-only skills (by name or id); unknown names fail", async () => {
    const a = await world();
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    await a.ok(["add", await folderSkill(a, "mine"), "-g", "-y"]);
    await a.ok(["add", await folderSkill(a, "other"), "-g", "-y"]);

    const share = await a.ok(["sync", "share", "mine"]);
    expect(share.stdout).toContain("Shared mine");
    expect(share.stdout).toContain(`edit it here from now on: ${path.join(a.store, "sync", "skills", "mine")}`);
    expect(share.stdout).toContain(`Synced to ${remote}`);
    expect((await remoteFiles(a, remote)).skills).toEqual(["mine"]);
    expect((await globals(a)).mine.id).toMatch(/my-skills\/mine$/);
    await settled(a);

    const again = await a.run(["sync", "share", "mine"]);
    expect(again.code).toBe(1);
    expect(again.stderr + again.stdout).toContain("No machine-only global skill named mine");

    const unknown = await a.run(["sync", "share", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("No machine-only global skill named nope");

    // Several at once, one of them by its full id.
    await a.ok(["add", await folderSkill(a, "third"), "-g", "-y"]);
    const otherId = (await globals(a)).other.id;
    const many = await a.ok(["sync", "share", otherId, "third"]);
    expect(many.stdout).toContain("Shared other");
    expect(many.stdout).toContain("Shared third");
    expect(many.stdout).not.toContain("✗");
    expect((await remoteFiles(a, remote)).skills).toEqual(["mine", "other", "third"]);
    await settled(a);

    // A known and an unknown name: all or nothing, every name is checked before anything is shared.
    await a.ok(["add", await folderSkill(a, "fourth"), "-g", "-y"]);
    const mixed = await a.run(["sync", "share", "fourth", "nope"]);
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toContain("No machine-only global skill named nope");
    expect(mixed.stdout).not.toContain("Shared");
    expect((await remoteFiles(a, remote)).skills).toEqual(["mine", "other", "third"]);
    expect((await globals(a)).fourth.id).toMatch(/^home:\/\//);
    await settled(a);

    // No selectors and no TTY: nothing to pick from interactively.
    expectUsageError(await a.run(["sync", "share"]), "skill");
  });

  test("a skill whose name is taken replaces the old one (kept, not global); sync reports a shadowed machine-only skill", async () => {
    const a = await world();
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    await a.ok(["add", await folderSkill(a, "dup", "Old copy"), "-g", "-y", "--share"]);
    const ownId = (await globals(a)).dup.id;
    const up = await a.repo("upstream", { "skills/dup/SKILL.md": skillMd("dup", "Upstream") });
    const add = await a.ok(["add", up.url, "-g", "-y"]);
    expect(add.stdout).toContain(`Replaced dup (${ownId}; kept in the store, not global)`);
    const files = await remoteFiles(a, remote);
    expect(files.skills).toEqual([]);
    expect(lastSegments(files.manifest)).toEqual(["dup"]);
    const index = await validateAll(a);
    expect(index.skills.find((r) => r.id === ownId)).toMatchObject({ global: false });
    await validateSync(a, { settled: true });

    const b = await a.machine("b");
    await b.ok(["add", await folderSkill(b, "memo", "B's memo"), "-g", "-y"]);
    await b.ok(["sync", "init", remote]);
    await a.ok(["add", await folderSkill(a, "memo", "A's memo"), "-g", "-y", "--share"]);
    const s = await b.ok(["sync"]);
    expect(s.stdout).toContain("memo from the sync repo now shadows another global memo");
    await settled(b);
  });
});

describe("disable / enable / status", () => {
  test("disable keeps changes local and refuses manual syncs; enable syncs without pushing or dropping them", async () => {
    const a = await world();
    const remote = await a.emptyRemote("my-skills");
    const up0 = await a.repo("upstream0", { "SKILL.md": skillMd("kept", "Kept skill") });
    await a.ok(["add", up0.url, "-g", "-y"]);
    await a.ok(["sync", "init", remote]);

    const d = await a.ok(["sync", "disable"]);
    expect(d.stdout).toContain(`Sync disabled. Nothing is pulled from or pushed to ${remote}`);
    expect((await readJson(path.join(a.store, "sync.json"))).enabled).toBe(false);
    await validateSync(a);

    const up = await a.repo("upstream", { "skills/delta/SKILL.md": skillMd("delta", "Delta") });
    const add = await a.ok(["add", up.url, "-g", "-y"]);
    expect(add.stderr).not.toContain("Synced");
    await a.ok(["remove", "kept", "-g", "-y"]);
    expect(lastSegments((await remoteFiles(a, remote)).manifest)).toEqual(["kept"]);
    await validateAll(a);

    const refused = await a.run(["sync"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("sync is disabled — run skill-library sync enable");
    expect((await a.ok(["sync", "status"])).stdout).toMatch(/Sync:\s+disabled/);
    expect((await readJson(path.join(a.store, "sync.json"))).enabled).toBe(false);

    const e = await a.ok(["sync", "enable"]);
    expect(e.stdout).toContain("Sync enabled");
    expect((await readJson(path.join(a.store, "sync.json"))).enabled).toBe(true);
    // delta stays local-only; the repo still lists kept, so the sync brings it back.
    expect(lastSegments((await remoteFiles(a, remote)).manifest)).toEqual(["kept"]);
    const g = await globals(a);
    expect(g.delta).toBeDefined();
    expect(g.kept).toBeDefined();
    await settled(a);
  });

  test("status: not set up, set up, and pending commits + lastError after a failed push (cleared once pushed)", async () => {
    const a = await world();
    expect((await a.ok(["sync", "status"])).stdout).toBe("Sync is not set up. Run skill-library sync init <git-url>\n");
    expect(await exists(path.join(a.store, "sync.json"))).toBe(false);

    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    const text = (await a.ok(["sync", "status"])).stdout;
    expect(text).toContain(`Repository: ${remote}`);
    expect(text).toMatch(/Sync:\s+enabled/);
    expect(text).toContain(`Clone:      ${path.join(a.store, "sync")}`);
    expect(text).toMatch(/Last sync:\s+\S/);
    expect(text).not.toContain("never");
    expect(text).not.toContain("Unpushed");
    expect(Date.parse((await readJson(path.join(a.store, "sync-status.json"))).lastSync)).not.toBeNaN();

    // The remote disappears: a global add commits locally and reports the failed push.
    const bare = bareOf(remote);
    await fsp.rename(bare, `${bare}.gone`);
    const up = await a.repo("upstream", { "SKILL.md": skillMd("solo", "Solo") });
    const add = await a.ok(["add", up.url, "-g", "-y"]);
    expect(add.stderr).toContain("sync:");
    expect(add.stderr).toContain("pushed on the next sync");
    const failed = await a.run(["sync"]);
    expect(failed.code).not.toBe(0);
    expect(typeof (await readJson(path.join(a.store, "sync-status.json"))).lastError).toBe("string");
    expect(Number(a.git(path.join(a.store, "sync"), ["rev-list", "--count", "@{u}..HEAD"]))).toBeGreaterThanOrEqual(1);
    const pendText = (await a.ok(["sync", "status"])).stdout;
    expect(pendText).toMatch(/Unpushed:\s+\d+ commit\(s\)/);
    expect(pendText).toContain("Last error:");
    await validateAll(a);

    // Back again: the next sync pushes the kept commit.
    await fsp.rename(`${bare}.gone`, bare);
    await a.ok(["sync"]);
    const afterText = (await a.ok(["sync", "status"])).stdout;
    expect(afterText).not.toContain("Unpushed");
    expect(afterText).not.toContain("Last error");
    expect((await readJson(path.join(a.store, "sync-status.json"))).lastError ?? null).toBeNull();
    expect(lastSegments((await remoteFiles(a, remote)).manifest)).toEqual(["solo"]);
    await settled(a);
  });
});

describe("sync update", () => {
  test("moves history, manifest and own skills to a new repo; own skills get new ids; later changes go there", async () => {
    const a = await world();
    const up = await a.repo("upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha") });
    await a.ok(["add", up.url, "-g", "-y"]);
    await a.ok(["add", await folderSkill(a, "mine"), "-g", "-y"]);
    const oldRemote = await a.emptyRemote("old-skills");
    await a.ok(["sync", "init", oldRemote, "--share", "mine"]);
    const oldHead = a.git(path.join(a.store, "sync"), ["rev-parse", "HEAD"]);
    const b = await a.machine("b");
    await b.ok(["sync", "init", oldRemote]);
    const up2 = await b.repo("upstream2", { "skills/beta/SKILL.md": skillMd("beta", "Beta") });
    await b.ok(["add", up2.url, "-g", "-y"]);

    const newRemote = await a.emptyRemote("new-skills");
    const move = await a.ok(["sync", "update", newRemote]);
    expect(move.stdout).toContain(`Sync moved from ${oldRemote} to ${newRemote}`);
    expect(move.stdout).toContain("+ beta");
    // The README init wrote for the old URL, unchanged, is replaced without asking.
    expect(move.stdout).toContain("Replaced the repository's README.md.");
    expect(move.stdout).toContain(`On your other machines, run skill-library sync update ${newRemote}`);
    expect(move.stdout).not.toMatch(/[+-] mine/);
    await settled(a);

    const files = await remoteFiles(a, newRemote);
    expect(lastSegments(files.manifest)).toEqual(["alpha", "beta"]);
    expect(files.skills).toEqual(["mine"]);
    expect(await fsp.readFile(path.join(files.dir, "README.md"), "utf8")).toContain(`sync init ${newRemote}`);
    // Full history moved (the old head is an ancestor).
    a.git(files.dir, ["merge-base", "--is-ancestor", oldHead, "HEAD"]);

    const ga = await globals(a);
    expect(Object.keys(ga).sort()).toEqual(["alpha", "beta", "mine"]);
    expect(ga.mine.id).toMatch(/new-skills\/mine$/);
    const index = await readJson(path.join(a.store, "index.json"));
    expect(index.skills.filter((r: any) => r.id.endsWith("/mine")).map((r: any) => r.id)).toEqual([ga.mine.id]);

    await a.ok(["add", await folderSkill(a, "other"), "-g", "-y", "--share"]);
    expect((await remoteFiles(a, newRemote)).skills).toEqual(["mine", "other"]);
    expect((await remoteFiles(a, oldRemote)).skills).toEqual(["mine"]);
    await settled(a);

    // B keeps using the old repo until it moves too.
    const bMove = await b.ok(["sync", "update", newRemote]);
    expect(bMove.stdout).toContain(`Sync moved from ${oldRemote} to ${newRemote}`);
    expect(Object.keys(await globals(b)).sort()).toEqual(["alpha", "beta", "mine", "other"]);
    await settled(b);

    const same = await a.ok(["sync", "update", newRemote]);
    expect(same.stdout).toContain(`Sync already uses ${newRemote}`);
    expect(same.stderr).toBe("");
  });

  test("--no-readme, a gone old repo, unrelated history, missing URL, not set up", async () => {
    const a = await world();
    const notSetUp = await a.run(["sync", "update", "file:///nowhere.git"]);
    expect(notSetUp.code).toBe(1);
    expect(notSetUp.stderr).toContain("sync init");
    const noUrl = await a.run(["sync", "update"]);
    expect(noUrl.code).toBe(1);
    expect(noUrl.stderr).toContain("Missing required argument: git-url");

    await a.ok(["add", await folderSkill(a, "mine"), "-g", "-y"]);
    const first = await a.emptyRemote("first");
    await a.ok(["sync", "init", first, "--share", "*"]);

    const unrelated = await a.repo("unrelated", { "README.md": "hello\n" });
    const refused = await a.run(["sync", "update", unrelated.url]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("unrelated history");
    expect((await readJson(path.join(a.store, "sync.json"))).url).toBe(first);
    expect(await fsp.readFile(path.join((await remoteFiles(a, unrelated.url)).dir, "README.md"), "utf8")).toBe("hello\n");
    await a.ok(["sync"]);
    await settled(a);

    const second = await a.emptyRemote("second");
    const j = await a.ok(["sync", "update", second, "--no-readme"]);
    expect(j.stdout).toContain(`Sync moved from ${first} to ${second}`);
    expect(j.stdout).not.toContain("README");
    expect((await readJson(path.join(a.store, "sync.json"))).url).toBe(second);
    const files = await remoteFiles(a, second);
    expect(files.skills).toEqual(["mine"]);
    // --no-readme: the README init wrote for the first URL is moved as it is, not rewritten.
    expect(await fsp.readFile(path.join(files.dir, "README.md"), "utf8")).toContain(`sync init ${first}`);
    await settled(a);

    // The old repository is gone: update says so and moves the clone as it is.
    await fsp.rm(bareOf(second), { recursive: true, force: true });
    const third = await a.emptyRemote("third");
    const moved = await a.ok(["sync", "update", third]);
    expect(moved.stderr).toContain(`Could not pull from ${second}`);
    expect((await remoteFiles(a, third)).skills).toEqual(["mine"]);
    expect((await globals(a)).mine.id).toMatch(/third\/mine$/);
    await settled(a);
  });
});

describe("background sync", () => {
  test("sync --background exits 0 silently and records its result", async () => {
    const a = await world();
    // Not set up: still silent and successful.
    const quiet = await a.run(["sync", "--background"]);
    expect(quiet).toMatchObject({ code: 0, stdout: "", stderr: "" });

    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    const before = (await readJson(path.join(a.store, "sync-status.json"))).lastSync;
    await new Promise((r) => setTimeout(r, 20));
    const bg = await a.run(["sync", "--background"]);
    expect(bg).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const status = await readJson(path.join(a.store, "sync-status.json"));
    expect(Date.parse(status.lastSync)).toBeGreaterThan(Date.parse(before));
    await settled(a);

    // A failing background run is silent too, and leaves the error in the status file.
    await fsp.rename(bareOf(remote), `${bareOf(remote)}.gone`);
    const failing = await a.run(["sync", "--background"]);
    expect(failing).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(typeof (await readJson(path.join(a.store, "sync-status.json"))).lastError).toBe("string");
  });

  test("query starts a background sync after the TTL; its changes are reported once, then cleared", async () => {
    const ts = await fakeTypeSafe();
    try {
      const env = { SKILL_LIBRARY_TYPESAFE_API_KEY: "k", SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url };
      const a = await world({ env });
      const remote = await a.emptyRemote("my-skills");
      await a.ok(["sync", "init", remote]);
      const b = await a.machine("b");
      await b.ok(["sync", "init", remote]);
      await b.ok(["add", await folderSkill(b, "zeta", "Zeta helps with zebra stripes"), "-g", "-y", "--share"]);

      // Within the TTL (the harness default) nothing starts.
      const lastAttempt = async () => (await readJson(path.join(a.store, "sync-status.json"))).lastAttempt;
      const t0 = await lastAttempt();
      await a.ok(["query", "anything at all"]);
      expect(await lastAttempt()).toBe(t0);

      const first = await a.ok(["query", "zebra stripes"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
      expect(first.stdout).not.toContain("Your skills changed");
      const g = await until(async () => (await globals(a)).zeta);
      expect(g, "background sync brought in zeta").toBeDefined();
      const status = await until(async () => (await readJson(path.join(a.store, "sync-status.json"))).unreported);
      expect(status).toEqual({ added: ["zeta"], removed: [], updated: [] });
      await settled(a);

      // The next successful query reports it (text), once.
      const told = await a.ok(["query", "zebra stripes"]);
      expect(told.stdout).toContain("zeta (92%)");
      expect(told.stdout).toContain("Your skills changed — tell the user:\n  added: zeta");
      const again = await a.ok(["query", "zebra stripes"]);
      expect(again.stdout).not.toContain("Your skills changed");

      // And in --json as syncChanges, after another background run that drops it.
      await b.ok(["remove", "zeta", "-g", "-y"]);
      await a.ok(["query", "x y z w"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
      await until(async () => (await readJson(path.join(a.store, "sync-status.json"))).unreported);
      const j = (await a.ok(["query", "zebra stripes", "--json"])).json();
      expect(j.syncChanges).toEqual({ added: [], removed: ["zeta"], updated: [] });
      expect((await a.ok(["query", "zebra stripes", "--json"])).json().syncChanges).toBeUndefined();
      await settled(a, b);
    } finally {
      await ts.close();
    }
  });
});

describe("background sync: disabled and failing", () => {
  test("query starts no background sync while sync is disabled; after a failed one it tells the agent once, without details", async () => {
    const a = await world();
    const ts = await fakeTypeSafe();
    try {
      a.env.SKILL_LIBRARY_TYPESAFE_API_BASE = ts.url;
      a.env.SKILL_LIBRARY_TYPESAFE_API_KEY = "k";
      const remote = await a.emptyRemote("my-skills");
      await a.ok(["sync", "init", remote]);
      const statusFile = path.join(a.store, "sync-status.json");
      const attempt = async () => (await readJson(statusFile)).lastAttempt as string;

      // Disabled: even with the TTL at 0, query leaves sync alone.
      await a.ok(["sync", "disable"]);
      const before = await attempt();
      const quiet = await a.ok(["query", "anything at all"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
      expect(quiet.stderr).toBe("");
      await new Promise((r) => setTimeout(r, 500));
      expect(await attempt()).toBe(before);

      // Enabled, remote gone: the background run fails and records it.
      await a.ok(["sync", "enable"]);
      const bare = bareOf(remote);
      await fsp.rename(bare, `${bare}.gone`);
      const started = await attempt();
      await a.ok(["query", "anything at all"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
      await until(async () => {
        const st = await readJson(statusFile);
        return st.lastAttempt !== started && typeof st.lastError === "string" ? st : null;
      });
      // The next query that starts one prints a single line, naming no error text, path or URL.
      const told = await a.ok(["query", "anything at all"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
      const lines = told.stderr.split("\n").filter(Boolean);
      expect(lines).toEqual(["skill-library: updating your skills failed last time — the user can run skill-library sync status for details"]);
      expect(told.stderr).not.toContain(remote);
      expect(told.stderr).not.toContain(a.store);
      // Within the TTL, nothing is started and nothing is printed.
      expect((await a.ok(["query", "anything at all"])).stderr).toBe("");
      await fsp.rename(`${bare}.gone`, bare);
      await until(async () => !(await fsp.readdir(path.join(a.store)).then((f) => f.includes("sync.lock"))));
    } finally {
      await ts.close();
    }
  });
});

describe("usage errors", () => {
  test("before setup, every subcommand but init/status says how to set it up and creates nothing", async () => {
    const a = await world();
    await a.ok(["add", await folderSkill(a, "mine"), "-g", "-y"]); // the library exists, sync doesn't
    for (const args of [["sync"], ["sync", "enable"], ["sync", "disable"], ["sync", "share", "x"], ["sync", "update", "file:///x.git"]]) {
      const r = await a.run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("Sync is not set up.");
      expect(r.stderr).toContain("Run skill-library sync init <git-url>");
    }
    expect(await exists(path.join(a.store, "sync.json"))).toBe(false);
    expect(await exists(path.join(a.store, "sync"))).toBe(false);
  });

test("before setup on a fresh machine (no library folder), enable/disable say how to set it up", async () => {
    const a = await world();
    for (const sub of ["enable", "disable"]) {
      const r = await a.run(["sync", sub]);
      expect(r.code, sub).toBe(1);
      expect(r.stderr).toContain("Sync is not set up.");
    }
  });

  test("while disabled, share and update refuse; enable and disable are idempotent", async () => {
    const a = await world();
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    await a.ok(["add", await folderSkill(a, "mine"), "-g", "-y"]);
    await a.ok(["sync", "disable"]);
    await a.ok(["sync", "disable"]);
    expect((await readJson(path.join(a.store, "sync.json"))).enabled).toBe(false);
    const share = await a.run(["sync", "share", "mine"]);
    expect(share.code).toBe(1);
    expect(share.stderr).toContain("sync is disabled — run skill-library sync enable");
    const next = await a.emptyRemote("next");
    const update = await a.run(["sync", "update", next]);
    expect(update.code).toBe(1);
    expect(update.stderr).toContain("sync is disabled — run skill-library sync enable first");
    expect((await readJson(path.join(a.store, "sync.json"))).url).toBe(remote);
    expect((await remoteFiles(a, remote)).skills).toEqual([]);
    await a.ok(["sync", "enable"]);
    const again = await a.ok(["sync", "enable"]);
    expect(again.stdout).toContain("Sync enabled");
    expect(again.stdout).toContain(`Global skills are in sync with ${remote}`);
    await settled(a);
  });

  test("--share only applies to init: on other subcommands it changes nothing", async () => {
    const a = await world();
    const remote = await a.emptyRemote("my-skills");
    await a.ok(["sync", "init", remote]);
    await a.ok(["add", await folderSkill(a, "mine"), "-g", "-y"]);
    const r = await a.ok(["sync", "--share", "mine"]);
    expect(r.stdout).toBe(`Global skills are in sync with ${remote}\n`);
    expect((await remoteFiles(a, remote)).skills).toEqual([]);
    expect((await globals(a)).mine.id).toMatch(/^home:\/\//);
    await settled(a);
  });

  test("--json is not a sync option: every subcommand either rejects it, or warns once and behaves exactly as without it", async () => {
    const a = await world();
    const probe = await a.run(["sync", "status", "--json"]);
    if (!expectUnknownOption(probe, "--json")) {
      // Rejected: a usage error on every subcommand, and nothing is set up.
      const remote = await a.emptyRemote("my-skills");
      for (const args of [["status"], ["init", remote], [], ["share", "x"], ["disable"], ["enable"], ["update", remote]]) {
        expectUsageError(await a.run(["sync", ...args, "--json"]), "--json");
      }
      expect(await exists(path.join(a.store, "sync.json"))).toBe(false);
      expect(await remoteFiles(a, remote).then((f) => f.files)).toEqual([]);
      return;
    }
    const unknown = (r: { stdout: string; stderr: string }) => (r.stdout + r.stderr).split("\n").filter((l) => l.includes("--json"));
    const st = await a.ok(["sync", "status", "--json"]);
    expect(unknown(st)).toHaveLength(1);
    expect(st.stdout).toBe("Sync is not set up. Run skill-library sync init <git-url>\n");

    const remote = await a.emptyRemote("my-skills");
    const init = await a.ok(["sync", "init", remote, "--json"]);
    expect(unknown(init)).toHaveLength(1);
    expect(init.stdout).toContain(`with ${remote} (pushed)`);
    expect(() => JSON.parse(init.stdout)).toThrow();
    await settled(a);

    const sync = await a.ok(["sync", "--json"]);
    expect(unknown(sync)).toHaveLength(1);
    expect(sync.stdout).toBe(`Global skills are in sync with ${remote}\n`);

    expect((await a.ok(["sync", "status", "--json"])).stdout).toContain(`Repository: ${remote}`);

    await a.ok(["add", await folderSkill(a, "mine"), "-g", "-y"]);
    const share = await a.ok(["sync", "share", "mine", "--json"]);
    expect(unknown(share)).toHaveLength(1);
    expect(share.stdout).toContain("Shared mine");
    expect((await remoteFiles(a, remote)).skills).toEqual(["mine"]);

    const failing = await a.run(["sync", "share", "nope", "--json"]);
    expect(failing.code).toBe(1);
    expect(failing.stdout + failing.stderr).toContain("No machine-only global skill named nope");

    const disable = await a.ok(["sync", "disable", "--json"]);
    expect(unknown(disable)).toHaveLength(1);
    expect(disable.stdout).toContain("Sync disabled.");
    const enable = await a.ok(["sync", "enable", "--json"]);
    expect(unknown(enable)).toHaveLength(1);
    expect(enable.stdout).toContain("Sync enabled");

    const next = await a.emptyRemote("next");
    const update = await a.ok(["sync", "update", next, "--json"]);
    expect(unknown(update)).toHaveLength(1);
    expect(update.stdout).toContain(`Sync moved from ${remote} to ${next}`);
    await settled(a);
  });

  test("an unknown sync command and --share without a value are usage errors", async () => {
    const w = await world();
    expectUsageError(await w.run(["sync", "frobnicate"]), "frobnicate");
    expectUsageError(await w.run(["sync", "--share"]), "--share");
    expect(await exists(w.store)).toBe(false);
  });
});
