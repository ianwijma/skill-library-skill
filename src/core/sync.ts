// Global sync through a git repository (docs/09-global-sync-options.md).
//
// The repo holds `skill-library.json` (git skills, pinned like a project manifest) and
// `skills/<name>/` folders (the user's own skills). Its clone lives at `<store>/sync`.
// `runSync` pulls, makes the repo's skills global in the store, updates the git skills to their
// newest version, writes the new pins back and pushes. `recordGlobalChange` is the hook the CLI
// calls after `add -g` / `remove -g` / `update -g` while sync is enabled.
//
// Global skills from a local folder are machine-only: they reach the repo only when the user
// shares them (`add -g --share`, `sync share`, or the pick at `sync init`).
import { spawn } from "node:child_process";
import { promises as fsp, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError, msgOf, warn } from "../lib/cli.ts";
import { parseSkillFile, requireStagedSkill } from "../lib/discover.ts";
import { assertSafeGitArgs, git, treeAt } from "../lib/git.ts";
import { hashSkillDir } from "../lib/hash.ts";
import { gitSkillId, isReservedSkillName, safeSlug, skillDirFor } from "../lib/ids.ts";
import { newReadme, repoOwner } from "../lib/sync-readme.ts";
import { MANIFEST, readManifest, serializeManifest, validateEntry, type Manifest, type ManifestEntry } from "../lib/manifest.ts";
import {
  copySkill,
  exists,
  findRecord,
  findVersion,
  isEnoent,
  now,
  openIndex,
  placeVersion,
  removeDir,
  stagingDir,
  versionDir,
  versionKeyFor,
  withFileLock,
  writeFileAtomic,
  type StoreIndex,
} from "../lib/store.ts";
import { ctxOf, mutateIndex, type BaseOptions } from "./context.ts";
import { installProject } from "./install.ts";
import { updateSkills } from "./update.ts";

export interface SyncConfig {
  /** Clone URL, exactly as given to `sync init`. */
  url: string;
  enabled: boolean;
  /** Ids made global by the repo at the last sync (so a skill dropped from the repo can be dropped here). */
  managed: string[];
}

export interface SyncChanges {
  added: string[];
  removed: string[];
  updated: string[];
  /** Names the repo now provides while another global skill with the same name exists. */
  shadowed?: string[];
}

export interface SyncStatusFile {
  lastAttempt?: string;
  lastSync?: string;
  lastError?: string | null;
  /** Changes made by background syncs that no `query` has shown yet. */
  unreported?: SyncChanges;
}

export interface SyncResult {
  url: string;
  /** Names that became global. */
  added: string[];
  /** Names that stopped being global because the repo dropped them. */
  removed: string[];
  /** Names moved to a newer version. */
  updated: string[];
  /** Names the repo made global while another global skill has the same name (query prefers the repo's). */
  shadowed: string[];
  pushed: boolean;
  /** Non-fatal problems (a skill that failed to install or update, a failed push). */
  errors: string[];
}

export interface SyncStatus {
  configured: boolean;
  url?: string;
  enabled?: boolean;
  clone?: string;
  lastSync?: string;
  lastAttempt?: string;
  lastError?: string | null;
  /** Local commits not pushed yet. */
  pending?: number;
}

export function syncPaths(store: string): { clone: string; config: string; status: string; lock: string } {
  return {
    clone: path.join(store, "sync"),
    config: path.join(store, "sync.json"),
    status: path.join(store, "sync-status.json"),
    lock: path.join(store, "sync.lock"),
  };
}

// ---------------------------------------------------------------------------
// Config and status files
// ---------------------------------------------------------------------------

function parseConfig(text: string, file: string): SyncConfig {
  let d: Partial<SyncConfig>;
  try {
    d = JSON.parse(text) as Partial<SyncConfig>;
  } catch {
    throw new CliError(2, `${file} is corrupted — fix or delete it`);
  }
  if (typeof d !== "object" || d === null || typeof d.url !== "string" || typeof d.enabled !== "boolean") {
    throw new CliError(2, `${file} is corrupted — fix or delete it`);
  }
  const managed = Array.isArray(d.managed) ? d.managed.filter((m): m is string => typeof m === "string") : [];
  return { url: d.url, enabled: d.enabled, managed };
}

export async function readSyncConfig(store: string): Promise<SyncConfig | null> {
  const file = syncPaths(store).config;
  try {
    return parseConfig(await fsp.readFile(file, "utf8"), file);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function writeSyncConfig(store: string, cfg: SyncConfig): Promise<void> {
  const out: SyncConfig = { url: cfg.url, enabled: cfg.enabled, managed: [...new Set(cfg.managed)].sort() };
  await writeFileAtomic(syncPaths(store).config, `${JSON.stringify(out, null, 2)}\n`);
}

function readStatusSync(store: string): SyncStatusFile {
  try {
    const d = JSON.parse(readFileSync(syncPaths(store).status, "utf8")) as SyncStatusFile;
    return typeof d === "object" && d !== null ? d : {};
  } catch {
    return {};
  }
}

function writeStatusSync(store: string, patch: SyncStatusFile): void {
  const file = syncPaths(store).status;
  const next = { ...readStatusSync(store), ...patch };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
}

function writeStatus(store: string, patch: SyncStatusFile): void {
  try {
    writeStatusSync(store, patch);
  } catch {
    // Status is informational only.
  }
}

async function requireConfig(store: string): Promise<SyncConfig> {
  const cfg = await readSyncConfig(store);
  if (!cfg) throw new CliError(1, "Sync is not set up.", "Run skill-library sync init <git-url>");
  return cfg;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function ok(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Commit identity fallback, so a machine without user.name/email can still sync. */
async function identity(cwd: string): Promise<string[]> {
  const has = (await ok(["config", "user.email"], cwd)) && (await ok(["config", "user.name"], cwd));
  return has ? [] : ["-c", "user.name=skill-library", "-c", "user.email=skill-library@localhost"];
}

async function hasHead(clone: string): Promise<boolean> {
  return ok(["rev-parse", "--verify", "-q", "HEAD"], clone);
}

async function branchOf(clone: string): Promise<string> {
  return git(["symbolic-ref", "--short", "HEAD"], { cwd: clone });
}

/** Stage everything; commit when something changed. */
async function commitAll(clone: string, message: string): Promise<boolean> {
  await git(["add", "-A"], { cwd: clone });
  if ((await git(["status", "--porcelain"], { cwd: clone })) === "") return false;
  await git([...(await identity(clone)), "commit", "-q", "-m", message], { cwd: clone });
  return true;
}

function canon(e: ManifestEntry | undefined): string | undefined {
  if (e === undefined) return undefined;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(e).sort()) sorted[k] = (e as unknown as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

/** Three-way merge of manifests per skill id: a side that changed wins; both changed → theirs (the remote). */
export function mergeManifests(base: Manifest, ours: Manifest, theirs: Manifest): Manifest {
  const out: Manifest = { version: 1, skills: {} };
  const ids = new Set([...Object.keys(base.skills), ...Object.keys(ours.skills), ...Object.keys(theirs.skills)]);
  for (const id of ids) {
    const b = canon(base.skills[id]);
    const o = canon(ours.skills[id]);
    const pick = o === b ? theirs.skills[id] : canon(theirs.skills[id]) === b ? ours.skills[id] : theirs.skills[id];
    if (pick !== undefined) out.skills[id] = pick;
  }
  return out;
}

async function manifestAt(clone: string, rev: string): Promise<Manifest> {
  let text: string;
  try {
    text = await git(["show", `${rev}:${MANIFEST}`], { cwd: clone });
  } catch {
    return { version: 1, skills: {} };
  }
  try {
    const d = JSON.parse(text) as Manifest;
    const skills: Record<string, ManifestEntry> = {};
    for (const [id, e] of Object.entries(d.skills ?? {})) skills[id] = validateEntry(`${rev}:${MANIFEST}`, id, e);
    return { version: 1, skills };
  } catch {
    return { version: 1, skills: {} };
  }
}

/**
 * Bring the clone up to date with the remote. Diverged history is rebased; if the rebase
 * conflicts, the remote is taken and the local changes are re-applied on top of it (the
 * manifest merged per skill, changed skill folders taken from the local side).
 */
async function pull(clone: string, url: string): Promise<void> {
  await git(["fetch", "-q", "origin"], { cwd: clone, url });
  const remote = `refs/remotes/origin/${await branchOf(clone)}`;
  if (!(await ok(["rev-parse", "--verify", "-q", remote], clone))) return; // nothing pushed yet
  if (!(await hasHead(clone))) {
    await git(["reset", "-q", "--hard", remote], { cwd: clone });
    return;
  }
  if (await ok(["merge-base", "--is-ancestor", remote, "HEAD"], clone)) return; // up to date or ahead
  if (await ok(["merge-base", "--is-ancestor", "HEAD", remote], clone)) {
    await git(["merge", "-q", "--ff-only", remote], { cwd: clone });
    return;
  }
  try {
    await git([...(await identity(clone)), "rebase", "-q", remote], { cwd: clone });
    return;
  } catch {
    await git(["rebase", "--abort"], { cwd: clone }).catch(() => {});
  }
  const old = await git(["rev-parse", "HEAD"], { cwd: clone });
  const base = await git(["merge-base", "HEAD", remote], { cwd: clone });
  const baseM = await manifestAt(clone, base);
  const oursM = await manifestAt(clone, old);
  const changed = (await git(["diff", "--name-only", "--no-renames", base, old, "--", "skills"], { cwd: clone })).split("\n").filter(Boolean);
  await git(["reset", "-q", "--hard", remote], { cwd: clone });
  for (const f of changed) {
    if (await ok(["cat-file", "-e", `${old}:${f}`], clone)) await git(["checkout", "-q", old, "--", f], { cwd: clone });
    else await fsp.rm(path.join(clone, f), { force: true });
  }
  const theirs = await manifestAt(clone, "HEAD");
  const merged = mergeManifests(baseM, oursM, theirs);
  if (Object.keys(merged.skills).length > 0 || (await exists(path.join(clone, MANIFEST)))) {
    await writeFileAtomic(path.join(clone, MANIFEST), serializeManifest(merged));
  }
  await commitAll(clone, "skill-library: merge local changes");
}

/** Push local commits; on rejection pull once and retry. Returns whether anything was pushed. */
async function push(clone: string, url: string): Promise<boolean> {
  if (!(await hasHead(clone))) return false;
  const branch = await branchOf(clone);
  const remote = `refs/remotes/origin/${branch}`;
  if ((await ok(["rev-parse", "--verify", "-q", remote], clone)) && (await ok(["merge-base", "--is-ancestor", "HEAD", remote], clone))) return false;
  const args = ["push", "-q", "origin", `HEAD:refs/heads/${branch}`];
  try {
    await git(args, { cwd: clone, url });
  } catch {
    await pull(clone, url);
    await git(args, { cwd: clone, url });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Repo ↔ store
// ---------------------------------------------------------------------------

interface OwnSkill {
  id: string;
  name: string;
  dir: string;
  /** Folder inside the repo, POSIX ("skills/foo"). */
  rel: string;
}

/** Skill folders under `skills/` in the clone. */
async function ownSkills(clone: string, url: string): Promise<OwnSkill[]> {
  const root = path.join(clone, "skills");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const out: OwnSkill[] = [];
  const seen = new Set<string>();
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const md = path.join(root, e.name, "SKILL.md");
    if (!(await exists(md))) continue;
    const parsed = await parseSkillFile(md, "folder");
    if (!parsed || isReservedSkillName(parsed.name)) continue;
    const id = gitSkillId(url, parsed.name);
    if (seen.has(id)) {
      warn(`sync: skills/${e.name} has the same name as another skill folder (${parsed.name}); skipped`);
      continue;
    }
    seen.add(id);
    out.push({ id, name: parsed.name, dir: path.join(root, e.name), rel: `skills/${e.name}` });
  }
  return out;
}

function nameOf(index: StoreIndex, id: string): string {
  const r = findRecord(index, id);
  return (r && r.versions[r.current]?.name) ?? id.split("/").pop() ?? id;
}

/** Make the store's global scope match the repo. Returns what changed; writes `cfg.managed`. */
async function applyRepo(store: string, cfg: SyncConfig): Promise<{ added: string[]; removed: string[]; shadowed: string[]; errors: string[] }> {
  const { clone } = syncPaths(store);
  const file = path.join(clone, MANIFEST);
  const errors: string[] = [];
  const own = await ownSkills(clone, cfg.url);
  const ownIds = new Set(own.map((o) => o.id));
  let manifest: Manifest = { version: 1, skills: {} };
  if (await exists(file)) {
    manifest = await readManifest(file);
    const res = await installProject({ store, cwd: clone });
    for (const r of res.skills) if (r.status === "missing" || r.status === "refused") errors.push(`${r.id}: ${r.message ?? r.status}`);
  }
  const entries = Object.entries(manifest.skills).filter(([id]) => {
    if (ownIds.has(id)) return false;
    if (id.startsWith("repo://")) return true;
    warn(`sync: ${id} is not a git skill; only git skills and skills/ folders are synced`);
    return false;
  });

  const head = (await hasHead(clone)) ? await git(["rev-parse", "HEAD"], { cwd: clone }) : null;
  const staged: Array<{ own: OwnSkill; dir: string; hash: string; tree: string | null; name: string; description: string }> = [];
  try {
    for (const o of own) {
      const dir = await stagingDir(store);
      staged.push({ own: o, dir, hash: "", tree: null, name: o.name, description: "" });
      const s = staged[staged.length - 1]!;
      await copySkill(o.dir, dir, "folder");
      s.hash = await hashSkillDir(dir);
      const meta = await requireStagedSkill(dir, o.id);
      s.name = meta.name;
      s.description = meta.description;
      s.tree = head ? await treeAt(clone, o.rel) : null;
    }

    const added: string[] = [];
    const removed: string[] = [];
    const shadowed: string[] = [];
    const desired = new Set<string>();
    const fresh = new Set<string>();
    await mutateIndex(store, async (index) => {
      for (const [id, e] of entries) {
        const record = findRecord(index, id);
        const key = record ? findVersion(record, { ...(e.commit ? { commit: e.commit } : {}), ...(e.hash ? { hash: e.hash } : {}) }) : undefined;
        if (!record || !key) continue; // install failed; already reported
        if (!record.global) (added.push(nameOf(index, id)), fresh.add(id));
        record.global = true;
        record.current = key;
        record.agents = e.agents;
        desired.add(id);
      }
      for (const s of staged) {
        const at = now();
        let record = findRecord(index, s.own.id);
        if (!record) {
          record = {
            id: s.own.id,
            source: { type: "git", url: cfg.url, ref: null, path: s.own.rel },
            dir: skillDirFor(s.own.id, s.name),
            versions: {},
            current: "",
            global: false,
            agents: "all",
            addedAt: at,
            updatedAt: at,
          };
          index.skills.push(record);
        }
        if (record.current !== "" && record.versions[record.current]?.hash === s.hash) {
          await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
        } else {
          const info = { ...(head ? { commit: head } : {}), hash: s.hash };
          const key = findVersion(record, info) ?? versionKeyFor(record, info);
          await placeVersion(s.dir, versionDir(store, record, key), s.hash);
          record.versions[key] ??= {
            ...(head ? { commit: head } : {}),
            ...(s.tree ? { tree: s.tree } : {}),
            hash: s.hash,
            name: s.name,
            description: s.description,
            addedAt: at,
          };
          record.current = key;
          record.updatedAt = at;
        }
        record.source = { type: "git", url: cfg.url, ref: null, path: s.own.rel };
        if (!record.global) (added.push(s.name), fresh.add(s.own.id));
        record.global = true;
        desired.add(s.own.id);
      }
      for (const id of cfg.managed) {
        if (desired.has(id)) continue;
        const record = findRecord(index, id);
        if (record?.global) {
          record.global = false;
          removed.push(nameOf(index, id));
        }
      }
      // A skill the repo just brought in may clash by name with one this machine already has
      // (e.g. a machine-only copy). Background syncs can't ask, so it is reported instead.
      for (const id of fresh) {
        const name = nameOf(index, id);
        if (index.skills.some((r) => r.global && r.id !== id && nameOf(index, r.id) === name)) shadowed.push(name);
      }
    });
    cfg.managed = [...desired];
    return { added, removed, shadowed, errors };
  } finally {
    for (const s of staged) await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Write each git entry's pin, name and agents from the store's global record. */
function refreshEntries(manifest: Manifest, index: StoreIndex): void {
  for (const [id, e] of Object.entries(manifest.skills)) {
    if (!id.startsWith("repo://")) continue;
    const record = findRecord(index, id);
    const v = record?.versions[record.current];
    if (!record || !record.global || !v?.commit) continue;
    e.commit = v.commit;
    e.hash = v.hash;
    e.name = v.name;
    e.agents = record.agents;
  }
}

async function readRepoManifest(clone: string): Promise<Manifest> {
  return readManifest(path.join(clone, MANIFEST));
}

async function writeRepoManifest(clone: string, manifest: Manifest): Promise<void> {
  const file = path.join(clone, MANIFEST);
  const next = serializeManifest(manifest);
  const cur = await fsp.readFile(file, "utf8").catch(() => null);
  if (cur !== next) await writeFileAtomic(file, next);
}

/** A free `skills/<slug>` folder in the clone for a skill named `name` (reuses one holding the same name). */
async function folderFor(clone: string, name: string): Promise<string> {
  const base = safeSlug(name);
  for (let i = 1; ; i++) {
    const rel = i === 1 ? base : `${base}-${i}`;
    const md = path.join(clone, "skills", rel, "SKILL.md");
    if (!(await exists(path.join(clone, "skills", rel)))) return rel;
    const parsed = await parseSkillFile(md, "folder", true);
    if (parsed?.name === name) return rel;
  }
}

/** Delete store records whose skill moved into the repo (it comes back under its repo id). */
async function dropRecords(store: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await mutateIndex(store, async (idx) => {
    for (const id of ids) {
      const r = findRecord(idx, id);
      if (!r) continue;
      idx.skills.splice(idx.skills.indexOf(r), 1);
      await removeDir(path.join(store, r.dir));
    }
  });
}

/** Copy a stored folder skill into the repo's skills/ folder. Returns the folder, or null. */
async function moveIntoRepo(store: string, clone: string, index: StoreIndex, id: string): Promise<string | null> {
  const record = findRecord(index, id);
  if (!record || !record.versions[record.current]) return null;
  const name = record.versions[record.current]!.name;
  const dest = path.join(clone, "skills", await folderFor(clone, name));
  await fsp.rm(dest, { recursive: true, force: true });
  await copySkill(versionDir(store, record, record.current), dest, "folder");
  return dest;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function syncLocked(store: string, cfg: SyncConfig): Promise<SyncResult> {
  const { clone } = syncPaths(store);
  const errors: string[] = [];
  await commitAll(clone, "skill-library: local changes");
  await pull(clone, cfg.url);
  const applied = await applyRepo(store, cfg);
  errors.push(...applied.errors);
  await writeSyncConfig(store, cfg);

  // Move every git skill to its newest version, then write the new pins back.
  const updated: string[] = [];
  const manifestFile = path.join(clone, MANIFEST);
  if (await exists(manifestFile)) {
    const ids = Object.keys((await readRepoManifest(clone)).skills).filter((id) => cfg.managed.includes(id) && id.startsWith("repo://"));
    const own = new Set((await ownSkills(clone, cfg.url)).map((o) => o.id));
    const follow = ids.filter((id) => !own.has(id));
    if (follow.length > 0) {
      const res = await updateSkills({ store, cwd: store, global: true, skills: follow });
      for (const r of res.skills) {
        if (r.status === "updated") updated.push(r.name);
        if (r.status === "failed") errors.push(`${r.name}: ${r.reason ?? "update failed"}`);
      }
    }
    const manifest = await readRepoManifest(clone);
    refreshEntries(manifest, await openIndex(store));
    await writeRepoManifest(clone, manifest);
  }
  await commitAll(clone, updated.length > 0 ? `skill-library: update ${updated.join(", ")}` : "skill-library: sync");
  let pushed = false;
  try {
    pushed = await push(clone, cfg.url);
  } catch (err) {
    errors.push(`push failed: ${msgOf(err)}`);
  }
  return { url: cfg.url, added: applied.added, removed: applied.removed, updated, shadowed: applied.shadowed, pushed, errors };
}

export interface RunSyncOptions extends BaseOptions {
  /** Started by `query`: skip quietly when another sync is running. */
  background?: boolean;
}

/** `skill-library sync`. Returns null when skipped (background run while another sync holds the lock). */
export async function runSync(opts: RunSyncOptions = {}): Promise<SyncResult | null> {
  const { store } = ctxOf(opts);
  const cfg = await requireConfig(store);
  if (!cfg.enabled) throw new CliError(1, "sync is disabled — run skill-library sync enable");
  const { lock } = syncPaths(store);
  // A background run has no terminal: never let ssh ask for anything.
  if (opts.background) process.env.GIT_SSH_COMMAND ??= "ssh -o BatchMode=yes";
  writeStatus(store, { lastAttempt: now() });
  let started = false;
  try {
    // Background runs wait only briefly: a live holder means a sync is already running (a dead one is reclaimed).
    const result = await withFileLock(
      lock,
      async () => {
        started = true;
        return syncLocked(store, (await readSyncConfig(store)) ?? cfg);
      },
      ...(opts.background ? [1000] : []),
    );
    writeStatus(store, {
      lastSync: now(),
      lastError: result.errors.length > 0 ? result.errors.join("; ") : null,
      // Nobody sees a background run's output: keep its changes for the next query to report.
      ...(opts.background ? { unreported: mergeChanges(readStatusSync(store).unreported, result) } : {}),
    });
    return result;
  } catch (err) {
    if (opts.background && !started) return null;
    writeStatus(store, { lastError: msgOf(err) });
    throw err;
  }
}

export type InitSyncOutcome =
  | {
      alreadySetUp: false;
      result: SyncResult;
      /** Names written into the empty repo: git skills, plus the folder skills chosen to share. */
      seeded: string[];
      /** Folder skills left machine-only (not shared). */
      machineOnly: string[];
      /** What happened to the repo's README (null: left as it was). */
      readme: ReadmeOutcome;
    }
  | { alreadySetUp: true; url: string };

/** A machine-only global skill that could be shared through the sync repo. */
export interface ShareCandidate {
  id: string;
  name: string;
  description: string;
}

export interface InitSyncOptions extends BaseOptions, ReadmeOptions {
  /**
   * Called only when the repo is empty and this machine has folder skills: return the ids to
   * share (copy into the repo's `skills/`). Default: share none — they stay machine-only.
   */
  chooseShare?: (candidates: ShareCandidate[]) => Promise<string[]>;
}

/** README handling shared by `sync init` and `sync update`. */
export interface ReadmeOptions {
  /** false: leave the repo's README alone (`--no-readme`). Default true. */
  readme?: boolean;
  /**
   * Called only when the repo already has a README (other than ours, as is): return true to
   * replace it. Default: keep it. A repo without a README always gets one.
   */
  confirmReadme?: (files: string[]) => Promise<boolean>;
}

export type ReadmeOutcome = { action: "created" | "replaced"; file: string } | null;

/**
 * Give the repo our README (assets/sync-readme.md): written when the repo has none; an existing
 * README (any README, README.md, README.rst, …) is replaced only when `confirmReadme` says so.
 * Commits; the caller pushes.
 */
async function seedReadme(clone: string, url: string, opts: ReadmeOptions, previousUrl?: string): Promise<ReadmeOutcome> {
  if (opts.readme === false) return null;
  const existing = (await fsp.readdir(clone)).filter((n) => /^readme(\.[^./]+)?$/i.test(n)).sort();
  const readmeFor = async (u: string): Promise<string> =>
    newReadme(u, repoOwner(u) ? null : await git(["config", "user.name"], { cwd: clone }).catch(() => null));
  const text = await readmeFor(url);
  const file = "README.md";
  const current = existing.length === 1 && existing[0] === file ? await fsp.readFile(path.join(clone, file), "utf8") : null;
  if (current === text) return null;
  // The README `sync init` wrote for the old URL, unchanged, is ours to refresh without asking.
  const ours = current !== null && previousUrl !== undefined && current === (await readmeFor(previousUrl));
  if (existing.length > 0 && !ours && !(opts.confirmReadme && (await opts.confirmReadme(existing)))) return null;
  for (const n of existing) await fsp.rm(path.join(clone, n), { force: true });
  await writeFileAtomic(path.join(clone, file), text);
  const action = existing.length === 0 ? "created" : "replaced";
  await commitAll(clone, `skill-library: ${action === "created" ? "add" : "replace"} README`);
  return { action, file };
}

/** Global skills from a local folder or file: they live only on this machine until shared. */
function machineOnlySkills(index: StoreIndex): ShareCandidate[] {
  const out: ShareCandidate[] = [];
  for (const record of index.skills) {
    const v = record.versions[record.current];
    if (!record.global || !v || record.source.type === "git") continue; // own skills are git-sourced too
    out.push({ id: record.id, name: v.name, description: v.description });
  }
  return out;
}

/**
 * `skill-library sync init <git-url>`: clone, seed an empty repo with the current global git
 * skills (and the folder skills the user chooses to share), then sync.
 * Re-running it with the URL already set up is a no-op; a different URL is refused.
 */
export async function initSync(url: string, opts: InitSyncOptions = {}): Promise<InitSyncOutcome> {
  const { store } = ctxOf(opts);
  const trimmed = url.trim();
  if (trimmed === "") throw new CliError(1, "Missing required argument: git-url", "Usage: skill-library sync init <git-url>");
  assertSafeGitArgs(trimmed);
  const paths = syncPaths(store);
  const existing = await readSyncConfig(store);
  if (existing?.url === trimmed) return { alreadySetUp: true, url: existing.url };
  if (existing) throw new CliError(1, `Sync is already set up with ${existing.url}`, `To move to ${trimmed}, run skill-library sync update ${trimmed}`);
  await fsp.mkdir(store, { recursive: true });
  await fsp.rm(paths.clone, { recursive: true, force: true }); // leftover of a failed init
  try {
    await git(["clone", "-q", "--", trimmed, paths.clone], { url: trimmed });
  } catch (err) {
    await fsp.rm(paths.clone, { recursive: true, force: true }).catch(() => {});
    throw new CliError(2, `Failed to clone ${trimmed}: ${msgOf(err)}`);
  }

  const cfg: SyncConfig = { url: trimmed, enabled: true, managed: [] };
  const seeded: string[] = [];
  const machineOnly: string[] = [];
  if (!(await hasHead(paths.clone))) {
    // Empty repo: start it with this machine's global git skills. Folder skills are shared only
    // when chosen: the CLI can't tell a skill you wrote from a copy of someone else's.
    const index = await openIndex(store);
    const candidates = machineOnlySkills(index);
    const share = new Set(candidates.length > 0 && opts.chooseShare ? await opts.chooseShare(candidates) : []);
    const manifest: Manifest = { version: 1, skills: {} };
    const moved: string[] = [];
    for (const record of index.skills) {
      const v = record.versions[record.current];
      if (!record.global || !v) continue;
      if (record.source.type !== "git" && !share.has(record.id)) {
        machineOnly.push(v.name);
        continue;
      }
      if (record.source.type === "git" && v.commit) {
        manifest.skills[record.id] = {
          name: v.name,
          source: record.source.url,
          ref: record.source.ref,
          path: record.source.path,
          commit: v.commit,
          hash: v.hash,
          agents: record.agents,
        };
        cfg.managed.push(record.id);
      } else if (await moveIntoRepo(store, paths.clone, index, record.id)) {
        moved.push(record.id);
      }
      seeded.push(v.name);
    }
    await writeRepoManifest(paths.clone, manifest);
    await commitAll(paths.clone, "skill-library: initial skills");
    await dropRecords(store, moved);
  }
  const readme = await seedReadme(paths.clone, trimmed, opts);
  await writeSyncConfig(store, cfg);
  const result = await runSync({ store });
  return { alreadySetUp: false, result: result!, seeded, machineOnly, readme };
}

export type UpdateSyncUrlOutcome =
  | { unchanged: true; url: string }
  | {
      unchanged: false;
      previousUrl: string;
      result: SyncResult;
      /** Set when the old repository could not be pulled first (local commits were still carried over). */
      oldPullError?: string;
      /** What happened to the new repository's README (null: left as it was). */
      readme: ReadmeOutcome;
    };

/**
 * `skill-library sync update <git-url>`: point the clone at a new repository, push everything
 * there and use it from now on. The new repository must be empty or share history with the old
 * one (a copy or a mirror). Own skills get ids under the new URL.
 */
export async function updateSyncUrl(url: string, opts: BaseOptions & ReadmeOptions = {}): Promise<UpdateSyncUrlOutcome> {
  const { store } = ctxOf(opts);
  const trimmed = url.trim();
  if (trimmed === "") throw new CliError(1, "Missing required argument: git-url", "Usage: skill-library sync update <git-url>");
  assertSafeGitArgs(trimmed);
  const paths = syncPaths(store);
  const cfg0 = await requireConfig(store);
  if (cfg0.url === trimmed) return { unchanged: true, url: trimmed };
  if (!cfg0.enabled) throw new CliError(1, "sync is disabled — run skill-library sync enable first");
  const { clone, lock } = paths;
  writeStatus(store, { lastAttempt: now() });
  try {
    const outcome = await withFileLock(lock, async (): Promise<UpdateSyncUrlOutcome> => {
      const cfg = (await readSyncConfig(store)) ?? cfg0;
      if (cfg.url === trimmed) return { unchanged: true, url: trimmed };
      const previousUrl = cfg.url;

      // Bring in what the old repository has, so nothing is left behind. It may be gone already.
      await commitAll(clone, "skill-library: local changes");
      let oldPullError: string | undefined;
      try {
        await pull(clone, previousUrl);
      } catch (err) {
        oldPullError = msgOf(err);
      }

      await git(["remote", "set-url", "--", "origin", trimmed], { cwd: clone });
      const restore = async (): Promise<void> => {
        await git(["remote", "set-url", "--", "origin", previousUrl], { cwd: clone }).catch(() => {});
        await git(["fetch", "-q", "--prune", "origin"], { cwd: clone, url: previousUrl }).catch(() => {});
      };
      try {
        // --prune drops the old repository's branches, so an empty new one gets a full push.
        await git(["fetch", "-q", "--prune", "origin"], { cwd: clone, url: trimmed });
      } catch (err) {
        await restore();
        throw new CliError(2, `Failed to reach ${trimmed}: ${msgOf(err)}`, `Sync still uses ${previousUrl}`);
      }
      const remote = `refs/remotes/origin/${await branchOf(clone)}`;
      if ((await hasHead(clone)) && (await ok(["rev-parse", "--verify", "-q", remote], clone)) && !(await ok(["merge-base", "HEAD", remote], clone))) {
        await restore();
        throw new CliError(
          1,
          `${trimmed} already holds unrelated history`,
          `Use an empty repository or a copy of ${previousUrl}. Sync still uses ${previousUrl}`,
        );
      }

      // Own skills are identified by the repo URL: drop the old records, applyRepo adds them back under the new ids.
      const moved = new Set<string>();
      const oldIds: string[] = [];
      for (const o of await ownSkills(clone, previousUrl)) {
        if (gitSkillId(trimmed, o.name) === o.id) continue;
        oldIds.push(o.id);
        moved.add(o.name);
      }
      await dropRecords(store, oldIds);
      cfg.managed = cfg.managed.filter((id) => !oldIds.includes(id));
      cfg.url = trimmed;
      await writeSyncConfig(store, cfg);

      const result = await syncLocked(store, cfg);
      result.added = result.added.filter((n) => !moved.has(n));
      // The clone now holds the new repository's files: give it the README for its URL.
      const readme = await seedReadme(clone, trimmed, opts, previousUrl);
      if (readme) result.pushed = (await push(clone, trimmed)) || result.pushed;
      return { unchanged: false, previousUrl, result, readme, ...(oldPullError ? { oldPullError } : {}) };
    });
    if (!outcome.unchanged) {
      writeStatus(store, { lastSync: now(), lastError: outcome.result.errors.length > 0 ? outcome.result.errors.join("; ") : null });
    }
    return outcome;
  } catch (err) {
    writeStatus(store, { lastError: msgOf(err) });
    throw err;
  }
}

export async function setSyncEnabled(enabled: boolean, opts: BaseOptions = {}): Promise<SyncConfig> {
  const { store } = ctxOf(opts);
  // Not set up (on a fresh machine the library folder doesn't even exist): say so before taking the lock.
  await requireConfig(store);
  return withFileLock(syncPaths(store).lock, async () => {
    const cfg = await requireConfig(store);
    cfg.enabled = enabled;
    await writeSyncConfig(store, cfg);
    return cfg;
  });
}

export async function syncStatus(opts: BaseOptions = {}): Promise<SyncStatus> {
  const { store } = ctxOf(opts);
  const cfg = await readSyncConfig(store);
  if (!cfg) return { configured: false };
  const { clone } = syncPaths(store);
  const status = readStatusSync(store);
  let pending: number | undefined;
  try {
    if (await hasHead(clone)) {
      const remote = `refs/remotes/origin/${await branchOf(clone)}`;
      const range = (await ok(["rev-parse", "--verify", "-q", remote], clone)) ? `${remote}..HEAD` : "HEAD";
      pending = Number(await git(["rev-list", "--count", range], { cwd: clone }));
    } else pending = 0;
  } catch {
    pending = undefined;
  }
  return {
    configured: true,
    url: cfg.url,
    enabled: cfg.enabled,
    clone,
    ...(status.lastSync ? { lastSync: status.lastSync } : {}),
    ...(status.lastAttempt ? { lastAttempt: status.lastAttempt } : {}),
    ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
    ...(pending !== undefined ? { pending } : {}),
  };
}

export interface GlobalChange {
  /** Ids just added (or re-added) to the global scope. */
  added?: string[];
  /** Ids just removed from the global scope. */
  removed?: string[];
  /**
   * Folder skills (among `added`) to share: copy into the repo's `skills/`, where they become own
   * skills. Folder skills not listed here stay machine-only and never reach the repo.
   */
  share?: string[];
}

/**
 * Hook for `add -g` / `remove -g` / `update -g`: write the change into the repo, commit and push.
 * Returns null when sync is not set up or disabled. Never throws for git problems; they come
 * back in `errors`.
 */
export async function recordGlobalChange(
  change: GlobalChange,
  opts: BaseOptions = {},
): Promise<{
  url: string;
  pushed: boolean;
  errors: string[];
  /** Skills the pull brought in or dropped, besides the change itself. */
  pulled: { added: string[]; removed: string[] };
  /** Skills copied into the repo (shared), with the folder to edit them in from now on. */
  shared: Array<{ name: string; path: string }>;
  /** Repo skills that now shadow another global skill with the same name. */
  shadowed: string[];
} | null> {
  const { store } = ctxOf(opts);
  const cfg0 = await readSyncConfig(store);
  if (!cfg0 || !cfg0.enabled) return null;
  const { clone, lock } = syncPaths(store);
  return withFileLock(lock, async () => {
    const cfg = (await readSyncConfig(store)) ?? cfg0;
    const errors: string[] = [];
    try {
      await commitAll(clone, "skill-library: local changes");
      await pull(clone, cfg.url);
    } catch (err) {
      errors.push(`pull failed: ${msgOf(err)}`);
    }
    const index = await openIndex(store);
    const manifest = await readRepoManifest(clone);
    const own = await ownSkills(clone, cfg.url);
    const ownById = new Map(own.map((o) => [o.id, o]));
    const moved: string[] = [];
    const names: string[] = [];
    const shared: Array<{ name: string; path: string }> = [];
    const share = new Set(change.share ?? []);
    for (const id of change.added ?? []) {
      const record = findRecord(index, id);
      const v = record?.versions[record.current];
      if (!record || !record.global || !v) continue;
      if (ownById.has(id)) {
        names.push(v.name);
        continue;
      }
      if (record.source.type === "git" && v.commit) {
        names.push(v.name);
        manifest.skills[id] = { name: v.name, source: record.source.url, ref: record.source.ref, path: record.source.path, commit: v.commit, hash: v.hash, agents: record.agents };
        cfg.managed.push(id);
      } else if (share.has(id)) {
        const dest = await moveIntoRepo(store, clone, index, id);
        if (dest) {
          names.push(v.name);
          shared.push({ name: v.name, path: dest });
          moved.push(id);
        }
      }
      // Otherwise a folder skill that wasn't shared: machine-only, the repo doesn't change.
    }
    for (const id of change.removed ?? []) {
      const o = ownById.get(id);
      if (!manifest.skills[id] && !o && !cfg.managed.includes(id)) continue; // machine-only: not in the repo
      names.push(id.split("/").pop() ?? id);
      delete manifest.skills[id];
      if (o) await fsp.rm(o.dir, { recursive: true, force: true });
      cfg.managed = cfg.managed.filter((m) => m !== id);
    }
    refreshEntries(manifest, index);
    await writeRepoManifest(clone, manifest);
    const verb = change.added?.length ? "add" : change.removed?.length ? "remove" : "update";
    await commitAll(clone, `skill-library: ${verb}${names.length > 0 ? ` ${names.join(", ")}` : ""}`);
    await dropRecords(store, moved);
    let pushed = false;
    try {
      pushed = await push(clone, cfg.url);
    } catch (err) {
      errors.push(`push failed: ${msgOf(err)}`);
    }
    const applied = await applyRepo(store, cfg);
    errors.push(...applied.errors);
    await writeSyncConfig(store, cfg);
    if (errors.length > 0) writeStatus(store, { lastError: errors.join("; ") });
    const mine = new Set(names);
    const pulled = { added: applied.added.filter((n) => !mine.has(n)), removed: applied.removed.filter((n) => !mine.has(n)) };
    return { url: cfg.url, pushed, errors, pulled, shared, shadowed: applied.shadowed };
  });
}

function changeCount(c: SyncChanges): number {
  return c.added.length + c.removed.length + c.updated.length + (c.shadowed?.length ?? 0);
}

function mergeChanges(prev: SyncChanges | undefined, next: SyncChanges): SyncChanges | undefined {
  const added = new Set(prev?.added ?? []);
  const removed = new Set(prev?.removed ?? []);
  const updated = new Set(prev?.updated ?? []);
  const shadowed = new Set(prev?.shadowed ?? []);
  for (const n of next.added) (removed.delete(n), added.add(n));
  for (const n of next.removed) (added.delete(n), updated.delete(n), shadowed.delete(n), removed.add(n));
  for (const n of next.updated) if (!added.has(n)) updated.add(n);
  for (const n of next.shadowed ?? []) shadowed.add(n);
  const out: SyncChanges = { added: [...added], removed: [...removed], updated: [...updated], ...(shadowed.size > 0 ? { shadowed: [...shadowed] } : {}) };
  return changeCount(out) > 0 ? out : undefined;
}

/** Return and clear the changes background syncs made since the last call (null when there are none). */
export function takeSyncChanges(store: string): SyncChanges | null {
  try {
    const changes = readStatusSync(store).unreported;
    if (!changes) return null;
    writeStatusSync(store, { unreported: undefined });
    return changeCount(changes) > 0 ? changes : null;
  } catch {
    return null;
  }
}

/** Default interval between background syncs (seconds); `SKILL_LIBRARY_SYNC_TTL` overrides it. */
export const DEFAULT_SYNC_TTL = 3600;

function syncTtlMs(): number {
  const raw = process.env.SKILL_LIBRARY_SYNC_TTL;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_SYNC_TTL) * 1000;
}

/**
 * Called by `query`: when sync is enabled and the last attempt is older than the TTL, start
 * `skill-library sync --background` detached and return at once. Returns a one-line notice about
 * the previous failure, if any. Never throws.
 */
export function maybeStartBackgroundSync(store: string): string | null {
  try {
    const file = syncPaths(store).config;
    const cfg = parseConfig(readFileSync(file, "utf8"), file);
    if (!cfg.enabled) return null;
    const status = readStatusSync(store);
    const last = Date.parse(status.lastAttempt ?? "") || 0;
    if (Date.now() - last < syncTtlMs()) return null;
    writeStatusSync(store, { lastAttempt: now() });
    const script = process.argv[1];
    if (!script) return null;
    const child = spawn(process.execPath, [...process.execArgv, script, "sync", "--background", "--store", store], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    // Printed to the agent: no git error text, paths or URLs, just a pointer for the user.
    return status.lastError ? "skill-library: updating your skills failed last time — the user can run skill-library sync status for details" : null;
  } catch {
    return null;
  }
}

export interface ShareResult {
  url: string;
  /** Skills copied into the repo, with the folder to edit them in from now on. */
  shared: Array<{ name: string; path: string }>;
  pushed: boolean;
  errors: string[];
}

/** Machine-only global skills (folder sources) that `sync share` can take. */
export async function shareableSkills(opts: BaseOptions = {}): Promise<ShareCandidate[]> {
  const { store } = ctxOf(opts);
  return machineOnlySkills(await openIndex(store));
}

/**
 * `skill-library sync share <skill...>`: copy machine-only global skills (by name or id) into the
 * repo's `skills/`, so every machine gets them. From then on the repo is their source of truth.
 */
export async function shareSkills(selectors: string[], opts: BaseOptions = {}): Promise<ShareResult> {
  const { store } = ctxOf(opts);
  const cfg = await requireConfig(store);
  if (!cfg.enabled) throw new CliError(1, "sync is disabled — run skill-library sync enable");
  if (selectors.length === 0) throw new CliError(1, "Missing required argument: skill", "Usage: skill-library sync share <skill...>");
  const candidates = machineOnlySkills(await openIndex(store));
  const ids: string[] = [];
  for (const sel of selectors) {
    const hits = candidates.filter((c) => c.id === sel || c.name === sel);
    if (hits.length === 0) {
      throw new CliError(1, `No machine-only global skill named ${sel}`, "Only global skills added from a local folder can be shared; see skill-library list -g");
    }
    if (hits.length > 1) throw new CliError(1, `${sel} matches several skills: ${hits.map((h) => h.id).join(", ")}`, "Pass the id instead");
    ids.push(hits[0]!.id);
  }
  const res = await recordGlobalChange({ added: ids, share: ids }, opts);
  if (!res) throw new CliError(1, "sync is disabled — run skill-library sync enable");
  return { url: res.url, shared: res.shared, pushed: res.pushed, errors: res.errors };
}
