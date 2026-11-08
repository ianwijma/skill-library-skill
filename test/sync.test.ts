import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { mergeManifests } from "../src/core/sync.ts";
import type { Manifest } from "../src/lib/manifest.ts";
import { git, gitRepo, readJson, run, sandbox, skillMd, writeFiles, type Sandbox } from "./helpers.ts";

/** An empty bare repository to sync through (file:// URL, so it behaves like any remote host). */
async function emptyRemote(sb: Sandbox, name = "my-skills"): Promise<string> {
  const bare = path.join(sb.root, "remotes", `${name}.git`);
  await fsp.mkdir(bare, { recursive: true });
  git(sb, bare, ["init", "-q", "--bare", "-b", "main"]);
  return `file://${bare}`;
}

async function globals(sb: Sandbox): Promise<Record<string, any>> {
  const rows = JSON.parse((await run(sb, ["list", "-g", "--json"])).stdout) as any[];
  return Object.fromEntries(rows.filter((r) => r.status === "tracked").map((r) => [r.name, r]));
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
    const a = await sandbox();
    const up = await gitRepo(a, "upstream", { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha skill") });
    await writeFiles(path.join(a.home, "mine"), { "SKILL.md": skillMd("mine", "My own skill") });
    expect((await run(a, ["add", up.url, "-g", "-y"])).code).toBe(0);
    expect((await run(a, ["add", path.join(a.home, "mine"), "-g", "-y"])).code).toBe(0);
    const remote = await emptyRemote(a);

    const init = await run(a, ["sync", "init", remote]);
    expect(init.code, init.stderr + init.stdout).toBe(0);
    expect(init.stdout).toContain("added this machine's 2 global skill(s)");

    const files = await remoteFiles(a, remote);
    expect(Object.keys(files.manifest.skills)).toEqual([expect.stringMatching(/\/alpha$/)]);
    expect(files.manifest.skills[Object.keys(files.manifest.skills)[0]!].commit).toBe(up.head);
    expect(files.skills).toEqual(["mine"]);

    const ga = await globals(a);
    expect(Object.keys(ga).sort()).toEqual(["alpha", "mine"]);
    expect(ga.mine.id).toMatch(/^repo:\/\/localhost\/.*my-skills\/mine$/);

    const b = await sandbox();
    const initB = await run(b, ["sync", "init", remote]);
    expect(initB.code, initB.stderr + initB.stdout).toBe(0);
    const gb = await globals(b);
    expect(Object.keys(gb).sort()).toEqual(["alpha", "mine"]);
    expect(await fsp.readFile(path.join(gb.mine.path, "SKILL.md"), "utf8")).toContain("My own skill");

    // Re-init is refused with the way out.
    const again = await run(b, ["sync", "init", remote]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already set up");
  });

  test("add -g / remove -g push; the other machine follows on sync", async () => {
    const a = await sandbox();
    const remote = await emptyRemote(a);
    expect((await run(a, ["sync", "init", remote])).code).toBe(0);
    const b = await sandbox();
    expect((await run(b, ["sync", "init", remote])).code).toBe(0);

    const up = await gitRepo(a, "upstream", { "skills/beta/SKILL.md": skillMd("beta", "Beta skill") });
    const add = await run(a, ["add", up.url, "-g", "-y", "-a", "codex"]);
    expect(add.code).toBe(0);
    expect(add.stderr).toContain(`Synced to ${remote}`);

    await writeFiles(path.join(a.home, "notes"), { "SKILL.md": skillMd("notes", "Notes skill") });
    expect((await run(a, ["add", path.join(a.home, "notes"), "-g", "-y"])).code).toBe(0);
    expect((await remoteFiles(a, remote)).skills).toEqual(["notes"]);
    // The folder skill now comes from the repo (no duplicate home:// global).
    expect((await globals(a)).notes.id).toMatch(/my-skills\/notes$/);

    const s = await run(b, ["sync"]);
    expect(s.code, s.stderr + s.stdout).toBe(0);
    let gb = await globals(b);
    expect(Object.keys(gb).sort()).toEqual(["beta", "notes"]);
    expect(gb.beta.agents).toEqual(["Codex"]);

    const rm = await run(a, ["remove", "beta", "notes", "-g", "-y"]);
    expect(rm.code, rm.stderr + rm.stdout).toBe(0);
    const files = await remoteFiles(a, remote);
    expect(files.manifest.skills).toEqual({});
    expect(files.skills).toEqual([]);
    expect((await run(b, ["sync"])).code).toBe(0);
    gb = await globals(b);
    expect(Object.keys(gb)).toEqual([]);
  });

  test("sync moves git skills to their newest version and pushes the new pin", async () => {
    const a = await sandbox();
    const up = await gitRepo(a, "upstream", { "skills/gamma/SKILL.md": skillMd("gamma", "Gamma v1") });
    expect((await run(a, ["add", up.url, "-g", "-y"])).code).toBe(0);
    const remote = await emptyRemote(a);
    expect((await run(a, ["sync", "init", remote])).code).toBe(0);
    const b = await sandbox();
    expect((await run(b, ["sync", "init", remote])).code).toBe(0);

    const v2 = await up.commit({ "skills/gamma/SKILL.md": skillMd("gamma", "Gamma v2") });
    const s = await run(a, ["sync"]);
    expect(s.code, s.stderr + s.stdout).toBe(0);
    expect(s.stdout).toContain("↑ gamma");
    const files = await remoteFiles(a, remote);
    expect(Object.values(files.manifest.skills)[0]).toMatchObject({ commit: v2 });

    expect((await run(b, ["sync"])).code).toBe(0);
    expect((await globals(b)).gamma.path).toContain(v2.slice(0, 12));
  });

  test("own skills edited in the repo reach every machine", async () => {
    const a = await sandbox();
    const remote = await emptyRemote(a);
    expect((await run(a, ["sync", "init", remote])).code).toBe(0);
    // Edit the repo from somewhere else (e.g. the web UI).
    const work = path.join(a.root, "elsewhere");
    git(a, a.root, ["clone", "-q", remote, work]);
    await writeFiles(work, { "skills/review/SKILL.md": skillMd("review", "Review v1") });
    git(a, work, ["add", "-A"]);
    git(a, work, ["commit", "-q", "-m", "add review"]);
    git(a, work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await run(a, ["sync"])).code).toBe(0);
    let ga = await globals(a);
    expect(ga.review).toBeDefined();

    await writeFiles(work, { "skills/review/SKILL.md": skillMd("review", "Review v2") });
    git(a, work, ["commit", "-qam", "edit review"]);
    git(a, work, ["push", "-q", "origin", "HEAD:main"]);
    expect((await run(a, ["sync"])).code).toBe(0);
    ga = await globals(a);
    expect(await fsp.readFile(path.join(ga.review.path, "SKILL.md"), "utf8")).toContain("Review v2");
  });

  test("disable keeps changes local; enable syncs again without pushing them", async () => {
    const a = await sandbox();
    const remote = await emptyRemote(a);
    expect((await run(a, ["sync", "init", remote])).code).toBe(0);
    const d = await run(a, ["sync", "disable"]);
    expect(d.code).toBe(0);
    expect(d.stdout).toContain("Sync disabled");

    const up = await gitRepo(a, "upstream", { "skills/delta/SKILL.md": skillMd("delta", "Delta") });
    const add = await run(a, ["add", up.url, "-g", "-y"]);
    expect(add.code).toBe(0);
    expect(add.stderr).not.toContain("Synced");
    expect((await remoteFiles(a, remote)).manifest.skills).toEqual({});

    const refused = await run(a, ["sync"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("sync is disabled — run skill-library sync enable");
    expect((await run(a, ["sync", "status"])).stdout).toContain("disabled");

    const e = await run(a, ["sync", "enable"]);
    expect(e.code, e.stderr + e.stdout).toBe(0);
    expect((await remoteFiles(a, remote)).manifest.skills).toEqual({});
    expect((await globals(a)).delta).toBeDefined(); // stays, as a local-only skill
  });

  test("diverged clones: manifest merged per skill, the remote wins when both changed", async () => {
    const a = await sandbox();
    const up = await gitRepo(a, "upstream", { "skills/eps/SKILL.md": skillMd("eps", "Eps") });
    expect((await run(a, ["add", up.url, "-g", "-y", "-a", "cursor"])).code).toBe(0);
    const remote = await emptyRemote(a);
    expect((await run(a, ["sync", "init", remote])).code).toBe(0);
    const b = await sandbox();
    expect((await run(b, ["sync", "init", remote])).code).toBe(0);

    // B changes the entry and adds an own skill locally (not pushed yet).
    const cloneB = path.join(b.store, "sync");
    const mB = await readJson(path.join(cloneB, "skill-library.json"));
    const id = Object.keys(mB.skills)[0]!;
    mB.skills[id].agents = ["codex"];
    await fsp.writeFile(path.join(cloneB, "skill-library.json"), `${JSON.stringify(mB, null, 2)}\n`);
    await writeFiles(cloneB, { "skills/bee/SKILL.md": skillMd("bee", "Bee") });
    git(b, cloneB, ["add", "-A"]);
    git(b, cloneB, ["commit", "-q", "-m", "local"]);

    // A changes the same entry and pushes first.
    expect((await run(a, ["add", up.url, "-g", "-y", "-a", "claude-code"])).code).toBe(0);

    const s = await run(b, ["sync"]);
    expect(s.code, s.stderr + s.stdout).toBe(0);
    const files = await remoteFiles(b, remote);
    expect(files.manifest.skills[id].agents).toEqual(["cursor", "claude-code"]); // A's change wins
    expect(files.skills).toEqual(["bee"]);
    // The rebase conflicted, so the per-skill merge ran.
    expect(git(b, cloneB, ["log", "--format=%s", "-3"])).toContain("skill-library: merge local changes");
  });

  test("query starts a background sync once the TTL has passed", async () => {
    const a = await sandbox();
    const remote = await emptyRemote(a);
    expect((await run(a, ["sync", "init", remote])).code).toBe(0);
    const work = path.join(a.root, "elsewhere");
    git(a, a.root, ["clone", "-q", remote, work]);
    await writeFiles(work, { "skills/zeta/SKILL.md": skillMd("zeta", "Zeta") });
    git(a, work, ["add", "-A"]);
    git(a, work, ["commit", "-q", "-m", "zeta"]);
    git(a, work, ["push", "-q", "origin", "HEAD:main"]);

    // No API key: the query itself fails, but the background sync has already started.
    await run(a, ["query", "anything"], { env: { SKILL_LIBRARY_SYNC_TTL: "0" } });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(await globals(a)).zeta) await new Promise((r) => setTimeout(r, 250));
    expect((await globals(a)).zeta).toBeDefined();

    // Within the TTL nothing is started.
    const before = (await readJson(path.join(a.store, "sync-status.json"))).lastAttempt;
    await run(a, ["query", "anything"]);
    expect((await readJson(path.join(a.store, "sync-status.json"))).lastAttempt).toBe(before);
  });

  test("init takes any clone URL as-is and reports a failing one", async () => {
    const a = await sandbox();
    const r = await run(a, ["sync", "init", "file:///nonexistent/repo.git"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Failed to clone file:///nonexistent/repo.git");
    expect((await run(a, ["sync", "status"])).stdout).toContain("not set up");
    expect((await run(a, ["sync"])).stderr).toContain("skill-library sync init <git-url>");
  });
});

describe("mergeManifests", () => {
  const e = (agents: any) => ({ source: "s", hash: `sha256-${"0".repeat(64)}`, commit: "a".repeat(40), path: "", ref: null, agents });
  test("keeps both sides' additions and removals; remote wins on conflicts", () => {
    const base: Manifest = { version: 1, skills: { keep: e("all"), dropOurs: e("all"), dropTheirs: e("all"), both: e("all") } };
    const ours: Manifest = { version: 1, skills: { keep: e("all"), dropTheirs: e("all"), both: e(["codex"]), newOurs: e("all") } };
    const theirs: Manifest = { version: 1, skills: { keep: e("all"), dropOurs: e("all"), both: e(["cursor"]), newTheirs: e("all") } };
    const m = mergeManifests(base, ours, theirs);
    expect(Object.keys(m.skills).sort()).toEqual(["both", "keep", "newOurs", "newTheirs"]);
    expect(m.skills.both!.agents).toEqual(["cursor"]);
  });
});
