import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { initSync, mergeManifests, updateSyncUrl } from "../src/core/sync.ts";
import type { Manifest } from "../src/lib/manifest.ts";
import { git, gitRepo, readJson, run, sandbox, skillMd, writeFiles, type Sandbox } from "./helpers.ts";

// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** An empty bare repository to sync through (file:// URL, so it behaves like any remote host). */
async function emptyRemote(sb: Sandbox, name = "my-skills"): Promise<string> {
  const bare = path.join(sb.root, "remotes", `${name}.git`);

  await fsp.mkdir(bare, { recursive: true });
  git(sb, bare, ["init", "-q", "--bare", "-b", "main"]);

  return `file://${bare}`;
}

/** A fresh clone of the remote's default branch, for looking at its files. */
async function peekClone(sb: Sandbox, url: string): Promise<string> {
  const dir = path.join(sb.root, `peek-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  git(sb, sb.root, ["clone", "-q", url, dir]);

  return dir;
}

async function globals(sb: Sandbox): Promise<Record<string, any>> {
  const rows = JSON.parse((await run(sb, ["list", "-g", "--json"])).stdout) as any[];

  return Object.fromEntries(rows.filter((row) => row.status === "tracked").map((row) => [row.name, row]));
}

/** Files of the remote's default branch, read through a fresh clone. */
async function remoteFiles(sb: Sandbox, url: string): Promise<{ manifest: any; skills: string[] }> {
  const dir = path.join(sb.root, `peek-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  git(sb, sb.root, ["clone", "-q", url, dir]);
  const manifest = await readJson(path.join(dir, "skill-library.json")).catch(() => null);
  const skills = await fsp.readdir(path.join(dir, "skills")).catch(() => [] as string[]);

  return { manifest, skills: skills.sort() };
}

describe("sync", () => {
  test("init seeds an empty repo; a second machine gets the same global skills", async () => {
    const machineA = await sandbox();
    const up = await gitRepo(machineA, "upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha skill") });

    await writeFiles(path.join(machineA.home, "mine"), { "SKILL.md": skillMd("mine", "My own skill") });
    expect((await run(machineA, ["add", up.url, "-g", "-y"])).code).toBe(0);
    expect((await run(machineA, ["add", path.join(machineA.home, "mine"), "-g", "-y"])).code).toBe(0);
    const remote = await emptyRemote(machineA);

    const init = await run(machineA, ["sync", "init", remote, "--share", "mine"]);

    expect(init.code, init.stderr + init.stdout).toBe(0);
    expect(init.stdout).toContain("added this machine's 2 global skill(s)");

    const files = await remoteFiles(machineA, remote);

    expect(Object.keys(files.manifest.skills)).toEqual([expect.stringMatching(/\/alpha$/)]);
    expect(files.manifest.skills[Object.keys(files.manifest.skills)[0]!].commit).toBe(up.head);
    expect(files.skills).toEqual(["mine"]);

    const ga = await globals(machineA);

    expect(Object.keys(ga).sort()).toEqual(["alpha", "mine"]);
    expect(ga.mine.id).toMatch(/^repo:\/\/localhost\/.*my-skills\/mine$/);

    const machineB = await sandbox();
    const initB = await run(machineB, ["sync", "init", remote]);

    expect(initB.code, initB.stderr + initB.stdout).toBe(0);
    const gb = await globals(machineB);

    expect(Object.keys(gb).sort()).toEqual(["alpha", "mine"]);
    expect(await fsp.readFile(path.join(gb.mine.path, "SKILL.md"), "utf8")).toContain("My own skill");

    // Re-init with the same URL is a no-op, not an error.
    const again = await run(machineB, ["sync", "init", remote]);

    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain(`already set up with ${remote}`);
    expect(again.stderr).toBe("");

    // A different URL is refused with the way out.
    const other = await run(machineB, ["sync", "init", `${remote}-other`]);

    expect(other.code).toBe(1);
    expect(other.stderr).toContain("already set up");
  });

  test("add -g / remove -g push; the other machine follows on sync", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const machineB = await sandbox();

    expect((await run(machineB, ["sync", "init", remote])).code).toBe(0);

    const up = await gitRepo(machineA, "upstream", { "skills/beta/SKILL.md": skillMd("beta", "Beta skill") });
    const add = await run(machineA, ["add", up.url, "-g", "-y", "-a", "codex"]);

    expect(add.code).toBe(0);
    expect(add.stderr).toContain(`Synced to ${remote}`);

    await writeFiles(path.join(machineA.home, "notes"), { "SKILL.md": skillMd("notes", "Notes skill") });
    const addNotes = await run(machineA, ["add", path.join(machineA.home, "notes"), "-g", "-y", "--share"]);

    expect(addNotes.code).toBe(0);
    expect(addNotes.stderr).not.toContain(`(from ${remote})`); // its own change isn't reported as pulled
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["notes"]);
    // The folder skill now comes from the repo (no duplicate home:// global).
    expect((await globals(machineA)).notes.id).toMatch(/my-skills\/notes$/);

    const syncResult = await run(machineB, ["sync"]);

    expect(syncResult.code, syncResult.stderr + syncResult.stdout).toBe(0);
    let gb = await globals(machineB);

    expect(Object.keys(gb).sort()).toEqual(["beta", "notes"]);
    expect(gb.beta.agents).toEqual(["Codex"]);

    const rm = await run(machineA, ["remove", "beta", "notes", "-g", "-y"]);

    expect(rm.code, rm.stderr + rm.stdout).toBe(0);
    const files = await remoteFiles(machineA, remote);

    expect(files.manifest.skills).toEqual({});
    expect(files.skills).toEqual([]);
    // A global add on B pulls first, and reports what the pull dropped.
    await writeFiles(path.join(machineB.home, "memo"), { "SKILL.md": skillMd("memo", "Memo skill") });
    const addMemo = await run(machineB, ["add", path.join(machineB.home, "memo"), "-g", "-y"]);

    expect(addMemo.code, addMemo.stderr).toBe(0);
    expect(addMemo.stderr).toContain(`beta (dropped by ${remote})`);
    expect(addMemo.stderr).toContain(`notes (dropped by ${remote})`);
    expect(addMemo.stderr).not.toContain("memo (");
    gb = await globals(machineB);
    expect(Object.keys(gb)).toEqual(["memo"]);
  });

  test("sync moves git skills to their newest version and pushes the new pin", async () => {
    const machineA = await sandbox();
    const up = await gitRepo(machineA, "upstream", { "skills/gamma/SKILL.md": skillMd("gamma", "Gamma v1") });

    expect((await run(machineA, ["add", up.url, "-g", "-y"])).code).toBe(0);
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const machineB = await sandbox();

    expect((await run(machineB, ["sync", "init", remote])).code).toBe(0);

    const v2 = await up.commit({ "skills/gamma/SKILL.md": skillMd("gamma", "Gamma v2") });
    const syncResult = await run(machineA, ["sync"]);

    expect(syncResult.code, syncResult.stderr + syncResult.stdout).toBe(0);
    expect(syncResult.stdout).toContain("↑ gamma");
    const files = await remoteFiles(machineA, remote);

    expect(Object.values(files.manifest.skills)[0]).toMatchObject({ commit: v2 });

    expect((await run(machineB, ["sync"])).code).toBe(0);
    expect((await globals(machineB)).gamma.path).toContain(v2.slice(0, 12));
  });

  test("own skills edited in the repo reach every machine", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    // Edit the repo from somewhere else (e.g. the web UI).
    const work = path.join(machineA.root, "elsewhere");

    git(machineA, machineA.root, ["clone", "-q", remote, work]);
    await writeFiles(work, { "skills/review/SKILL.md": skillMd("review", "Review v1") });
    git(machineA, work, ["add", "-A"]);
    git(machineA, work, ["commit", "-q", "-m", "add review"]);
    git(machineA, work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await run(machineA, ["sync"])).code).toBe(0);
    let ga = await globals(machineA);

    expect(ga.review).toBeDefined();

    await writeFiles(work, { "skills/review/SKILL.md": skillMd("review", "Review v2") });
    git(machineA, work, ["commit", "-qam", "edit review"]);
    git(machineA, work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await run(machineA, ["sync"])).code).toBe(0);
    ga = await globals(machineA);
    expect(await fsp.readFile(path.join(ga.review.path, "SKILL.md"), "utf8")).toContain("Review v2");
  });

  test("disable keeps changes local; enable syncs again without pushing them", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const disabled = await run(machineA, ["sync", "disable"]);

    expect(disabled.code).toBe(0);
    expect(disabled.stdout).toContain("Sync disabled");

    const up = await gitRepo(machineA, "upstream", { "skills/delta/SKILL.md": skillMd("delta", "Delta") });
    const add = await run(machineA, ["add", up.url, "-g", "-y"]);

    expect(add.code).toBe(0);
    expect(add.stderr).not.toContain("Synced");
    expect((await remoteFiles(machineA, remote)).manifest.skills).toEqual({});

    const refused = await run(machineA, ["sync"]);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("sync is disabled — run skill-library sync enable");
    expect((await run(machineA, ["sync", "status"])).stdout).toContain("disabled");

    const enabled = await run(machineA, ["sync", "enable"]);

    expect(enabled.code, enabled.stderr + enabled.stdout).toBe(0);
    expect((await remoteFiles(machineA, remote)).manifest.skills).toEqual({});
    expect((await globals(machineA)).delta).toBeDefined(); // stays, as a local-only skill
  });

  test("diverged clones: manifest merged per skill, the remote wins when both changed", async () => {
    const machineA = await sandbox();
    const up = await gitRepo(machineA, "upstream", { "skills/eps/SKILL.md": skillMd("eps", "Eps") });

    expect((await run(machineA, ["add", up.url, "-g", "-y", "-a", "cursor"])).code).toBe(0);
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const machineB = await sandbox();

    expect((await run(machineB, ["sync", "init", remote])).code).toBe(0);

    // B changes the entry and adds an own skill locally (not pushed yet).
    const cloneB = path.join(machineB.store, "sync");
    const mB = await readJson(path.join(cloneB, "skill-library.json"));
    const id = Object.keys(mB.skills)[0]!;

    mB.skills[id].agents = ["codex"];
    await fsp.writeFile(path.join(cloneB, "skill-library.json"), `${JSON.stringify(mB, null, 2)}\n`);
    await writeFiles(cloneB, { "skills/bee/SKILL.md": skillMd("bee", "Bee") });
    git(machineB, cloneB, ["add", "-A"]);
    git(machineB, cloneB, ["commit", "-q", "-m", "local"]);

    // A changes the same entry and pushes first.
    expect((await run(machineA, ["add", up.url, "-g", "-y", "-a", "claude-code"])).code).toBe(0);

    const syncResult = await run(machineB, ["sync"]);

    expect(syncResult.code, syncResult.stderr + syncResult.stdout).toBe(0);
    const files = await remoteFiles(machineB, remote);

    expect(files.manifest.skills[id].agents).toEqual(["cursor", "claude-code"]); // A's change wins
    expect(files.skills).toEqual(["bee"]);
    // The rebase conflicted, so the per-skill merge ran.
    expect(git(machineB, cloneB, ["log", "--format=%s", "-3"])).toContain("skill-library: merge local changes");
  });

  test("query starts a background sync once the TTL has passed", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const work = path.join(machineA.root, "elsewhere");

    git(machineA, machineA.root, ["clone", "-q", remote, work]);
    await writeFiles(work, { "skills/zeta/SKILL.md": skillMd("zeta", "Zeta") });
    git(machineA, work, ["add", "-A"]);
    git(machineA, work, ["commit", "-q", "-m", "zeta"]);
    git(machineA, work, ["push", "-q", "origin", "HEAD:main"]);

    // No API key: the query itself fails, but the background sync has already started.
    await run(machineA, ["query", "anything"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline && !(await globals(machineA)).zeta) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect((await globals(machineA)).zeta).toBeDefined();
    // The background run's changes wait for the next successful query to report them.
    let status: any = {};

    while (Date.now() < deadline && !(status = await readJson(path.join(machineA.store, "sync-status.json"))).unreported) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(status.unreported).toEqual({ added: ["zeta"], removed: [], updated: [] });

    // Within the TTL nothing is started.
    const before = (await readJson(path.join(machineA.store, "sync-status.json"))).lastAttempt;

    await run(machineA, ["query", "anything"]);
    expect((await readJson(path.join(machineA.store, "sync-status.json"))).lastAttempt).toBe(before);
  });

  test("update pushes everything to the new repo and uses it from then on", async () => {
    const machineA = await sandbox();
    const up = await gitRepo(machineA, "upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha skill") });

    await writeFiles(path.join(machineA.home, "mine"), { "SKILL.md": skillMd("mine", "My own skill") });
    expect((await run(machineA, ["add", up.url, "-g", "-y"])).code).toBe(0);
    expect((await run(machineA, ["add", path.join(machineA.home, "mine"), "-g", "-y"])).code).toBe(0);
    const oldRemote = await emptyRemote(machineA, "old-skills");

    expect((await run(machineA, ["sync", "init", oldRemote, "--share", "mine"])).code).toBe(0);
    const machineB = await sandbox();

    expect((await run(machineB, ["sync", "init", oldRemote])).code).toBe(0);

    // Machine B pushes a skill to the old repo that A hasn't pulled yet: update brings it along.
    const up2 = await gitRepo(machineB, "upstream2", { "skills/beta/SKILL.md": skillMd("beta", "Beta skill") });

    expect((await run(machineB, ["add", up2.url, "-g", "-y"])).code).toBe(0);

    const newRemote = await emptyRemote(machineA, "new-skills");
    const move = await run(machineA, ["sync", "update", newRemote]);

    expect(move.code, move.stderr + move.stdout).toBe(0);
    expect(move.stdout).toContain(`Sync moved from ${oldRemote} to ${newRemote}`);
    expect(move.stdout).toContain("+ beta");
    expect(move.stdout).not.toContain("+ mine");
    expect(move.stdout).not.toContain("- mine");

    const files = await remoteFiles(machineA, newRemote);

    expect(Object.keys(files.manifest.skills).map((id) => id.split("/").pop()).sort()).toEqual(["alpha", "beta"]);
    expect(files.skills).toEqual(["mine"]);

    const status = await readJson(path.join(machineA.store, "sync.json"));

    expect(status.url).toBe(newRemote);
    const ga = await globals(machineA);

    expect(Object.keys(ga).sort()).toEqual(["alpha", "beta", "mine"]);
    expect(ga.mine.id).toMatch(/new-skills\/mine$/);
    // The record under the old repo's id is gone, not left behind as a non-global duplicate.
    const index = await readJson(path.join(machineA.store, "index.json"));

    expect(index.skills.filter((row: any) => row.id.endsWith("/mine")).map((row: any) => row.id)).toEqual([ga.mine.id]);

    // Later changes go to the new repo.
    await writeFiles(path.join(machineA.home, "other"), { "SKILL.md": skillMd("other", "Another skill") });
    expect((await run(machineA, ["add", path.join(machineA.home, "other"), "-g", "-y", "--share"])).code).toBe(0);
    expect((await remoteFiles(machineA, newRemote)).skills).toEqual(["mine", "other"]);
    expect((await remoteFiles(machineA, oldRemote)).skills).toEqual(["mine"]);

    // The same URL again is a no-op.
    const again = await run(machineA, ["sync", "update", newRemote]);

    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain(`already uses ${newRemote}`);
  });

  test("update refuses a repo with unrelated history and keeps the old URL", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const unrelated = await gitRepo(machineA, "unrelated", { "README.md": "hello\n" });
    const res = await run(machineA, ["sync", "update", unrelated.url]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unrelated history");
    const status = await readJson(path.join(machineA.store, "sync.json"));

    expect(status.url).toBe(remote);
    expect((await run(machineA, ["sync"])).code).toBe(0);
  });

  test("update works when the old repo is gone", async () => {
    const machineA = await sandbox();

    await writeFiles(path.join(machineA.home, "mine"), { "SKILL.md": skillMd("mine", "My own skill") });
    expect((await run(machineA, ["add", path.join(machineA.home, "mine"), "-g", "-y"])).code).toBe(0);
    const oldRemote = await emptyRemote(machineA, "old-skills");

    expect((await run(machineA, ["sync", "init", oldRemote, "--share", "*"])).code).toBe(0);
    await fsp.rm(oldRemote.replace("file://", ""), { recursive: true, force: true });

    const newRemote = await emptyRemote(machineA, "new-skills");
    const move = await run(machineA, ["sync", "update", newRemote]);

    expect(move.code, move.stderr + move.stdout).toBe(0);
    expect(move.stderr).toContain(`Could not pull from ${oldRemote}`);
    expect((await remoteFiles(machineA, newRemote)).skills).toEqual(["mine"]);
  });

  test("init keeps folder skills machine-only unless chosen", async () => {
    const machineA = await sandbox();
    const up = await gitRepo(machineA, "upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha skill") });

    await writeFiles(path.join(machineA.home, "copy"), { "SKILL.md": skillMd("copy", "A copied skill") });
    expect((await run(machineA, ["add", up.url, "-g", "-y"])).code).toBe(0);
    expect((await run(machineA, ["add", path.join(machineA.home, "copy"), "-g", "-y"])).code).toBe(0);
    const remote = await emptyRemote(machineA);

    const init = await run(machineA, ["sync", "init", remote]);

    expect(init.code, init.stderr + init.stdout).toBe(0);
    expect(plain(init.stdout)).toContain("Kept machine-only (not synced): copy");
    const files = await remoteFiles(machineA, remote);

    expect(Object.keys(files.manifest.skills).map((id) => id.split("/").pop())).toEqual(["alpha"]);
    expect(files.skills).toEqual([]);
    // Still global here, under its folder id.
    const ga = await globals(machineA);

    expect(Object.keys(ga).sort()).toEqual(["alpha", "copy"]);
    expect(ga.copy.id).not.toMatch(/^repo:/);

    const machineB = await sandbox();

    expect((await run(machineB, ["sync", "init", remote])).code).toBe(0);
    expect(Object.keys(await globals(machineB))).toEqual(["alpha"]);
  });

  test("add -g of a folder stays machine-only until shared; sync share syncs it", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const machineB = await sandbox();

    expect((await run(machineB, ["sync", "init", remote])).code).toBe(0);

    await writeFiles(path.join(machineA.home, "mine"), { "SKILL.md": skillMd("mine", "My own skill") });
    const add = await run(machineA, ["add", path.join(machineA.home, "mine"), "-g", "-y"]);

    expect(add.code, add.stderr).toBe(0);
    expect(add.stderr).toContain("mine is machine-only (not synced). To share it: skill-library sync share mine");
    expect((await remoteFiles(machineA, remote)).skills).toEqual([]);

    const share = await run(machineA, ["sync", "share", "mine"]);

    expect(share.code, share.stderr + share.stdout).toBe(0);
    expect(share.stdout).toContain("Shared mine");
    expect(share.stdout).toContain(path.join(machineA.store, "sync", "skills", "mine"));
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["mine"]);
    expect((await globals(machineA)).mine.id).toMatch(/my-skills\/mine$/);

    expect((await run(machineB, ["sync"])).code).toBe(0);
    expect(Object.keys(await globals(machineB))).toEqual(["mine"]);

    // Nothing left to share; an unknown name says what can be shared.
    const none = await run(machineA, ["sync", "share", "mine"]);

    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No machine-only global skill named mine");
  });

  test("re-sharing a folder over your own skill of the same name updates it", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const dir = path.join(machineA.home, "notes");

    await writeFiles(dir, { "SKILL.md": skillMd("notes", "Notes v1") });
    expect((await run(machineA, ["add", dir, "-g", "-y", "--share"])).code).toBe(0);
    await writeFiles(dir, { "SKILL.md": skillMd("notes", "Notes v2") });
    const again = await run(machineA, ["add", dir, "-g", "-y", "--share"]);

    expect(again.code, again.stderr + again.stdout).toBe(0);
    expect(again.stdout).not.toContain("Replaced");
    const globalSkills = await globals(machineA);

    expect(Object.keys(globalSkills)).toEqual(["notes"]);
    expect(await fsp.readFile(path.join(globalSkills.notes.path, "SKILL.md"), "utf8")).toContain("Notes v2");
    expect((await remoteFiles(machineA, remote)).skills).toEqual(["notes"]);
  });

  test("adding a skill whose name is taken replaces the old one (kept, not global)", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    // Your own copy of a skill, then its upstream.
    await writeFiles(path.join(machineA.home, "dup"), { "SKILL.md": skillMd("dup", "Old copy") });
    expect((await run(machineA, ["add", path.join(machineA.home, "dup"), "-g", "-y", "--share"])).code).toBe(0);
    const ownId = (await globals(machineA)).dup.id;
    const up = await gitRepo(machineA, "upstream", { "skills/dup/SKILL.md": skillMd("dup", "Upstream") });

    const add = await run(machineA, ["add", up.url, "-g", "-y"]);

    expect(add.code, add.stderr + add.stdout).toBe(0);
    expect(plain(add.stdout)).toContain(`Replaced dup (${ownId}; kept in the store, not global)`);
    const globalSkills = await globals(machineA);

    expect(Object.keys(globalSkills)).toEqual(["dup"]);
    expect(globalSkills.dup.id).toMatch(/upstream\/dup$/);
    const files = await remoteFiles(machineA, remote);

    expect(files.skills).toEqual([]);
    expect(Object.keys(files.manifest.skills).map((id) => id.split("/").pop())).toEqual(["dup"]);
    const index = await readJson(path.join(machineA.store, "index.json"));

    expect(index.skills.find((row: any) => row.id === ownId)).toMatchObject({ global: false });
  });

  test("sync reports a repo skill that shadows a machine-only one", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const machineB = await sandbox();

    expect((await run(machineB, ["sync", "init", remote])).code).toBe(0);
    await writeFiles(path.join(machineB.home, "memo"), { "SKILL.md": skillMd("memo", "B's memo") });
    expect((await run(machineB, ["add", path.join(machineB.home, "memo"), "-g", "-y"])).code).toBe(0);

    await writeFiles(path.join(machineA.home, "memo"), { "SKILL.md": skillMd("memo", "A's memo") });
    expect((await run(machineA, ["add", path.join(machineA.home, "memo"), "-g", "-y", "--share"])).code).toBe(0);

    const syncResult = await run(machineB, ["sync"]);

    expect(syncResult.code, syncResult.stderr + syncResult.stdout).toBe(0);
    expect(syncResult.stdout).toContain("memo from the sync repo now shadows another global memo");
  });

  test("update without sync set up says how to set it up", async () => {
    const machineA = await sandbox();
    const res = await run(machineA, ["sync", "update", "file:///nowhere.git"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("sync init");
  });

  test("init takes any clone URL as-is and reports a failing one", async () => {
    const machineA = await sandbox();
    const result = await run(machineA, ["sync", "init", "file:///nonexistent/repo.git"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Failed to clone file:///nonexistent/repo.git");
    expect((await run(machineA, ["sync", "status"])).stdout).toContain("not set up");
    expect((await run(machineA, ["sync"])).stderr).toContain("skill-library sync init <git-url>");
  });
  test("init adds a README to a repo without one; --no-readme leaves it out", async () => {
    const machineA = await sandbox();
    const remote = await emptyRemote(machineA);

    expect((await run(machineA, ["sync", "init", remote])).code).toBe(0);
    const readme = await fsp.readFile(path.join(await peekClone(machineA, remote), "README.md"), "utf8");

    expect(readme).toContain("](https://github.com/ianwijma/skill-library-skill)");
    expect(readme).toContain(`skill-library sync init ${remote}`);
    expect(readme).not.toContain("{{");

    const machineB = await sandbox();
    const bare = await emptyRemote(machineB);

    expect((await run(machineB, ["sync", "init", bare, "--no-readme"])).code).toBe(0);
    expect(await fsp.readdir(await peekClone(machineB, bare))).not.toContain("README.md");
  });

  test("an existing README is replaced only when confirmed", async () => {
    const machineA = await sandbox();
    const up = await gitRepo(machineA, "has-readme", { "README.rst": "Mine\n" });
    const kept = await run(machineA, ["sync", "init", up.url]); // no terminal to ask in: kept

    expect(kept.code, kept.stderr + kept.stdout).toBe(0);
    expect(await fsp.readdir(await peekClone(machineA, up.url))).toEqual([".git", "README.rst"]);

    const machineB = await sandbox();
    let asked: string[] = [];
    const outcome = await initSync(up.url, {
      store: machineB.store,
      confirmReadme: async (files) => ((asked = files), true),
    });

    expect(asked).toEqual(["README.rst"]);
    expect(!outcome.alreadySetUp && outcome.readme).toEqual({ action: "replaced", file: "README.md" });
    const dir = await peekClone(machineB, up.url);

    expect((await fsp.readdir(dir)).sort()).toEqual([".git", "README.md"]);
    expect(await fsp.readFile(path.join(dir, "README.md"), "utf8")).toContain(`sync init ${up.url}`);
  });

  test("update gives the new repository its README", async () => {
    const machineA = await sandbox();
    const first = await emptyRemote(machineA, "first");

    expect((await run(machineA, ["sync", "init", first])).code).toBe(0);
    const second = await emptyRemote(machineA, "second");
    const moved = await run(machineA, ["sync", "update", second]);

    expect(moved.code, moved.stderr + moved.stdout).toBe(0);
    // The README init wrote for the old URL is refreshed without asking.
    expect(await fsp.readFile(path.join(await peekClone(machineA, second), "README.md"), "utf8")).toContain(`sync init ${second}`);

    // One you edited is yours: replaced only when confirmed.
    const work = await peekClone(machineA, second);

    await fsp.writeFile(path.join(work, "README.md"), "# Edited\n");
    git(machineA, work, ["commit", "-qam", "edit readme"]);
    git(machineA, work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await run(machineA, ["sync"])).code).toBe(0);
    const third = await emptyRemote(machineA, "third");
    let asked: string[] = [];
    const outcome = await updateSyncUrl(third, {
      store: machineA.store,
      confirmReadme: async (files) => ((asked = files), true),
    });

    expect(asked).toEqual(["README.md"]);
    expect(!outcome.unchanged && outcome.readme).toEqual({ action: "replaced", file: "README.md" });
    expect(await fsp.readFile(path.join(await peekClone(machineA, third), "README.md"), "utf8")).toContain(`sync init ${third}`);
  });
});

describe("mergeManifests", () => {
  const makeEntry = (agents: any) => ({ source: "s", hash: `sha256-${"0".repeat(64)}`, commit: "a".repeat(40), path: "", ref: null, agents });

  test("keeps both sides' additions and removals; remote wins on conflicts", () => {
    const base: Manifest = { version: 1, skills: { keep: makeEntry("all"), dropOurs: makeEntry("all"), dropTheirs: makeEntry("all"), both: makeEntry("all") } };
    const ours: Manifest = { version: 1, skills: { keep: makeEntry("all"), dropTheirs: makeEntry("all"), both: makeEntry(["codex"]), newOurs: makeEntry("all") } };
    const theirs: Manifest = { version: 1, skills: { keep: makeEntry("all"), dropOurs: makeEntry("all"), both: makeEntry(["cursor"]), newTheirs: makeEntry("all") } };
    const merged = mergeManifests(base, ours, theirs);

    expect(Object.keys(merged.skills).sort()).toEqual(["both", "keep", "newOurs", "newTheirs"]);
    expect(merged.skills.both!.agents).toEqual(["cursor"]);
  });
});
