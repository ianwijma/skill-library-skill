// Global sync through a git repository (docs/09-global-sync-options.md).
//
// The repo holds `skill-library.json` (git skills, pinned like a project manifest) and
// `skills/<name>/` folders (the user's own skills). Its clone lives at `<store>/sync`.
// `runSync` pulls, makes the repo's skills global in the store, updates the git skills to their
// newest version, writes the new pins back and pushes. `recordGlobalChange` is the hook the CLI
// calls after `add -g` / `remove -g` / `update -g` while sync is enabled.
import { spawn } from "node:child_process";
import { promises as fsp, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError, msgOf, warn } from "../lib/cli.ts";
import { parseSkillFile, requireStagedSkill } from "../lib/discover.ts";
import { assertSafeGitArgs, git, treeAt } from "../lib/git.ts";
import { hashSkillDir } from "../lib/hash.ts";
import { gitSkillId, isReservedSkillName, safeSlug, skillDirFor } from "../lib/ids.ts";
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

export interface SyncStatusFile {
  lastAttempt?: string;
  lastSync?: string;
  lastError?: string | null;
}

export interface SyncResult {
  url: string;
  /** Names that became global. */
  added: string[];
  /** Names that stopped being global because the repo dropped them. */
  removed: string[];
  /** Names moved to a newer version. */
  updated: string[];
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
async function applyRepo(store: string, cfg: SyncConfig): Promise<{ added: string[]; removed: string[]; errors: string[] }> {
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
    const desired = new Set<string>();
    await mutateIndex(store, async (index) => {
      for (const [id, e] of entries) {
        const record = findRecord(index, id);
        const key = record ? findVersion(record, { ...(e.commit ? { commit: e.commit } : {}), ...(e.hash ? { hash: e.hash } : {}) }) : undefined;
        if (!record || !key) continue; // install failed; already reported
        if (!record.global) added.push(nameOf(index, id));
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
        if (!record.global) added.push(s.name);
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
    });
    cfg.managed = [...desired];
    return { added, removed, errors };
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

/** Copy a stored folder skill into the repo's skills/ folder. */
async function moveIntoRepo(store: string, clone: string, index: StoreIndex, id: string): Promise<boolean> {
  const record = findRecord(index, id);
  if (!record || !record.versions[record.current]) return false;
  const name = record.versions[record.current]!.name;
  const dest = path.join(clone, "skills", await folderFor(clone, name));
  await fsp.rm(dest, { recursive: true, force: true });
  await copySkill(versionDir(store, record, record.current), dest, "folder");
  return true;
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
  return { url: cfg.url, added: applied.added, removed: applied.removed, updated, pushed, errors };
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
    writeStatus(store, { lastSync: now(), lastError: result.errors.length > 0 ? result.errors.join("; ") : null });
    return result;
  } catch (err) {
    if (opts.background && !started) return null;
    writeStatus(store, { lastError: msgOf(err) });
    throw err;
  }
}

/** `skill-library sync init <git-url>`: clone, seed an empty repo with the current global skills, then sync. */
export async function initSync(url: string, opts: BaseOptions = {}): Promise<{ result: SyncResult; seeded: string[] }> {
  const { store } = ctxOf(opts);
  const trimmed = url.trim();
  if (trimmed === "") throw new CliError(1, "Missing required argument: git-url", "Usage: skill-library sync init <git-url>");
  assertSafeGitArgs(trimmed);
  const paths = syncPaths(store);
  const existing = await readSyncConfig(store);
  if (existing) throw new CliError(1, `Sync is already set up with ${existing.url}`, `To start over, delete ${paths.config} and ${paths.clone}`);
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
  if (!(await hasHead(paths.clone))) {
    // Empty repo: start it with this machine's global skills.
    const index = await openIndex(store);
    const manifest: Manifest = { version: 1, skills: {} };
    const moved: string[] = [];
    for (const record of index.skills) {
      const v = record.versions[record.current];
      if (!record.global || !v) continue;
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
  await writeSyncConfig(store, cfg);
  const result = await runSync({ store });
  return { result: result!, seeded };
}

export async function setSyncEnabled(enabled: boolean, opts: BaseOptions = {}): Promise<SyncConfig> {
  const { store } = ctxOf(opts);
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
}

/**
 * Hook for `add -g` / `remove -g` / `update -g`: write the change into the repo, commit and push.
 * Returns null when sync is not set up or disabled. Never throws for git problems; they come
 * back in `errors`.
 */
export async function recordGlobalChange(change: GlobalChange, opts: BaseOptions = {}): Promise<{ url: string; pushed: boolean; errors: string[] } | null> {
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
    for (const id of change.added ?? []) {
      const record = findRecord(index, id);
      const v = record?.versions[record.current];
      if (!record || !record.global || !v) continue;
      names.push(v.name);
      if (ownById.has(id)) continue;
      if (record.source.type === "git" && v.commit) {
        manifest.skills[id] = { name: v.name, source: record.source.url, ref: record.source.ref, path: record.source.path, commit: v.commit, hash: v.hash, agents: record.agents };
        cfg.managed.push(id);
      } else if (await moveIntoRepo(store, clone, index, id)) {
        moved.push(id);
      }
    }
    for (const id of change.removed ?? []) {
      names.push(id.split("/").pop() ?? id);
      delete manifest.skills[id];
      const o = ownById.get(id);
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
    return { url: cfg.url, pushed, errors };
  });
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
    return status.lastError ? `skill-library: the last sync failed: ${status.lastError} (see skill-library sync status)` : null;
  } catch {
    return null;
  }
}
