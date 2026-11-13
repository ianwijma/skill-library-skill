import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CliError, msgOf, warn } from "./cli.ts";
import { SKIP_BASENAMES, hashSkillDir, hexOf } from "./hash.ts";
import { indexPath, lockPath, skillsRoot } from "./paths.ts";

/** `"all"` = every agent; otherwise the agent ids the skill is for. */
export type AgentsValue = "all" | string[];

export interface SourceInfo {
  type: "git" | "folder" | "file";
  /** Clone URL (git) or absolute path (folder/file). */
  url: string;
  /** Branch/tag followed by update; null = default branch. A full SHA is fixed. */
  ref: string | null;
  /** Skill folder inside the repository ("" = repository root). Unused for local sources. */
  path: string;
}

export interface VersionInfo {
  commit?: string;
  tree?: string;
  hash: string;
  name: string;
  description: string;
  addedAt: string;
}

export interface StoreRecord {
  id: string;
  /** Global follow target (project operations follow their manifest entry instead). */
  source: SourceInfo;
  /** Skill folder relative to the store, e.g. "skills/react-best-practices-3f9c1a2e". */
  dir: string;
  versions: Record<string, VersionInfo>;
  /** Version used in global scope. */
  current: string;
  global: boolean;
  /** Global usage only; project assignments live in each skill-library.json. */
  agents: AgentsValue;
  addedAt: string;
  updatedAt: string;
}

export interface StoreIndex {
  version: 1;
  skills: StoreRecord[];
}

export function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export function now(): string {
  return new Date().toISOString();
}

/** Read index.json; an absent file is an empty index. */
export async function openIndex(store: string): Promise<StoreIndex> {
  const file = indexPath(store);
  let text: string;

  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return emptyIndex();
    }

    throw new CliError(2, `cannot read ${file}: ${msgOf(err)}`);
  }

  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError(2, `index.json is corrupted — fix or restore ${file}`);
  }

  if (isIndex(data)) {
    return data;
  }

  throw new CliError(2, `index.json is corrupted — fix or restore ${file}`);
}

function isIndex(data: unknown): data is StoreIndex {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  const fields = data as Record<string, unknown>;

  return fields.version === 1 && Array.isArray(fields.skills) && fields.skills.every(isRecord);
}

function isRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const fields = value as Record<string, unknown>;

  return (
    typeof fields.id === "string"
    && typeof fields.dir === "string"
    && typeof fields.current === "string"
    && typeof fields.versions === "object"
    && fields.versions !== null
    && typeof fields.source === "object"
    && fields.source !== null
  );
}

export function emptyIndex(): StoreIndex {
  return { version: 1, skills: [] };
}

export async function saveIndex(store: string, index: StoreIndex): Promise<void> {
  index.skills.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  await writeFileAtomic(indexPath(store), `${JSON.stringify(index, null, 2)}\n`);
}

export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const fh = await fsp.open(tmp, "w");

    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }

    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new CliError(2, `cannot write ${file}: ${msgOf(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

interface LockInfo {
  pid: number;
  host: string;
  at: string;
  token?: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

const LOCK_WAIT_MS = 15_000;

/** Take index.lock, run `fn`, release. Waits while a live local holder has it. */
export async function withLock<T>(store: string, fn: () => Promise<T>): Promise<T> {
  await fsp.mkdir(store, { recursive: true }).catch((err: unknown) => {
    throw new CliError(2, `cannot create store directory ${store}: ${msgOf(err)}`);
  });

  return withFileLock(lockPath(store), fn);
}

async function readHolder(file: string): Promise<LockInfo | null | "gone"> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as LockInfo;
  } catch (err) {
    return isEnoent(err) ? "gone" : null;
  }
}

/**
 * Remove a dead holder's lock. Reclamation is serialised by an atomic `mkdir` guard and the lock
 * is re-read under it, so a contender that decided "stale" earlier can never delete a newer,
 * live owner's lock.
 */
async function reclaimStale(file: string, stale: LockInfo): Promise<void> {
  const guard = `${file}.reclaim`;

  try {
    await fsp.mkdir(guard);
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") {
      throw err;
    }

    // Another process is reclaiming. Never remove its guard (fail closed): the caller waits,
    // and an abandoned guard is reported with the path to delete once the wait runs out.
    return;
  }

  try {
    const current = await readHolder(file);

    if (current !== null && current !== "gone" && current.token === stale.token && current.pid === stale.pid) {
      await fsp.rm(file, { force: true });
    }
  } finally {
    await fsp.rmdir(guard).catch(() => {});
  }
}

/** Lock file holding pid@host and a unique token. Dead local holders are reclaimed; foreign ones fail (exit 2). */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, waitMs: number = LOCK_WAIT_MS): Promise<T> {
  const mine: LockInfo = { pid: process.pid, host: os.hostname(), at: now(), token: randomBytes(12).toString("hex") };
  const deadline = Date.now() + waitMs;

  for (;;) {
    // Write the holder info first, then hard-link it into place: the lock never exists empty.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;

    try {
      await fsp.writeFile(tmp, JSON.stringify(mine));
      await fsp.link(tmp, file);
      await fsp.rm(tmp, { force: true });
      break;
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});

      if ((err as { code?: string }).code !== "EEXIST") {
        throw new CliError(2, `cannot create ${file}: ${msgOf(err)}`);
      }
    }

    const holder = await readHolder(file);

    if (holder === "gone") {
      continue; // released between our attempt and the read: try again
    }

    if (holder?.host === os.hostname() && typeof holder.pid === "number" && !pidAlive(holder.pid)) {
      if (Date.now() >= deadline) {
        throw new CliError(
          2,
          `${path.basename(file)} is held by a crashed process and could not be reclaimed; `
          + `delete ${file} and ${file}.reclaim if no skill-library is running`,
        );
      }

      await reclaimStale(file, holder);
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }

    if (holder?.host === os.hostname() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    const who = holder ? `${holder.pid}@${holder.host}` : "an unknown process";

    throw new CliError(2, `${path.basename(file)} held by ${who}; delete ${file} if no skill-library is running`);
  }

  try {
    return await fn();
  } finally {
    // Release only our own lock.
    const holder = await readHolder(file);

    if (holder !== null && holder !== "gone" && holder.token === mine.token) {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Versions and content
// ---------------------------------------------------------------------------

export function findRecord(index: StoreIndex, id: string): StoreRecord | undefined {
  return index.skills.find((record) => record.id === id);
}

/** Version key for content: git → 12 hex of the commit, local → "h-" + 12 hex of the hash. */
export function versionKeyFor(record: StoreRecord | undefined, info: { commit?: string; hash: string }): string {
  const full = info.commit ?? hexOf(info.hash);
  const prefix = info.commit ? "" : "h-";

  for (const len of [12, 16, 24, full.length]) {
    const key = `${prefix}${full.slice(0, len)}`;
    const existing = record?.versions[key];

    if (!existing || sameVersion(existing, info)) {
      return key;
    }
  }

  return `${prefix}${full}`;
}

export function sameVersion(version: VersionInfo, info: { commit?: string; hash: string }): boolean {
  if (info.commit !== undefined) {
    return version.commit === info.commit && version.hash === info.hash;
  }

  return version.commit === undefined && version.hash === info.hash;
}

/** The version a pin (commit for git, hash for local) points at, if it is in the record. */
export function findVersion(record: StoreRecord, pin: { commit?: string; hash?: string }): string | undefined {
  for (const [key, version] of Object.entries(record.versions)) {
    if (pin.commit !== undefined) {
      if (version.commit === pin.commit && (pin.hash === undefined || version.hash === pin.hash)) {
        return key;
      }
    } else if (pin.hash !== undefined && version.commit === undefined && version.hash === pin.hash) {
      return key;
    }
  }

  return undefined;
}

export function versionDir(store: string, record: StoreRecord, key: string): string {
  return path.join(store, record.dir, key);
}

export function versionSkillMd(store: string, record: StoreRecord, key: string): string {
  return path.join(versionDir(store, record, key), "SKILL.md");
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);

    return true;
  } catch {
    return false;
  }
}

/** Fresh staging folder inside the store (same filesystem, so renames are atomic). */
export async function stagingDir(store: string): Promise<string> {
  const dir = path.join(store, ".staging", `${process.pid}-${randomBytes(6).toString("hex")}`);

  await fsp.mkdir(path.dirname(dir), { recursive: true });

  return dir;
}

/** Copy a skill folder (or a single markdown file as SKILL.md) into `dest`, skipping junk. */
export async function copySkill(src: string, dest: string, kind: "folder" | "file"): Promise<void> {
  if (kind === "file") {
    await fsp.mkdir(dest, { recursive: true });
    await fsp.copyFile(src, path.join(dest, "SKILL.md"));

    return;
  }

  await copyTree(src, dest);
}

async function copyTree(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_BASENAMES.has(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyTree(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    } else {
      warn(`skipped non-regular file: ${srcPath}`);
    }
  }
}

/**
 * Move a staged copy into place as a version folder. If the version folder already
 * exists (same full version), the staged copy is discarded.
 */
export async function commitVersionDir(staged: string, dest: string): Promise<void> {
  try {
    if (await exists(dest)) {
      await fsp.rm(staged, { recursive: true, force: true });

      return;
    }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(staged, dest);
  } catch (err) {
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw new CliError(2, `cannot write ${dest}: ${msgOf(err)}`);
  }
}

/**
 * Put a verified staged copy at `dest` (caller holds the store lock). An existing folder is kept
 * only when it is intact (regular SKILL.md and the same content hash); otherwise it is replaced
 * with rollback. Returns what happened.
 */
export async function placeVersion(staged: string, dest: string, hash: string): Promise<"kept" | "placed" | "repaired"> {
  if (!(await exists(dest))) {
    await commitVersionDir(staged, dest);

    return "placed";
  }

  const md = await fsp.lstat(path.join(dest, "SKILL.md")).catch(() => null);

  if (md?.isFile() && (await hashSkillDir(dest)) === hash) {
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});

    return "kept";
  }

  await replaceVersionDir(staged, dest);

  return "repaired";
}

/** Repair: swap a staged copy over an existing version folder, rolling back on failure. */
export async function replaceVersionDir(staged: string, dest: string): Promise<void> {
  const backup = `${dest}.old-${randomBytes(4).toString("hex")}`;
  let hadOld = false;

  try {
    try {
      await fsp.rename(dest, backup);
      hadOld = true;
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
    }

    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(staged, dest);
    } catch (err) {
      if (hadOld) {
        await fsp.rename(backup, dest).catch(() => {});
      }

      throw err;
    }

    if (hadOld) {
      await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw new CliError(2, `cannot replace ${dest}: ${msgOf(err)}`);
  }
}

export async function removeDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (err) {
    throw new CliError(2, `cannot delete ${dir}: ${msgOf(err)}`);
  }
}

export function storeSkillsRoot(store: string): string {
  return skillsRoot(store);
}
