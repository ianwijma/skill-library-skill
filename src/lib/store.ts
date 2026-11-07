import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CliError, msgOf, warn } from "./cli.ts";
import { SKIP_BASENAMES, hexOf } from "./hash.ts";
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
  version: 2;
  skills: StoreRecord[];
}

export function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export function now(): string {
  return new Date().toISOString();
}

/** Read index.json as-is: a v2 index, a raw v1 array, or null when absent. */
export async function readRawIndex(store: string): Promise<StoreIndex | unknown[] | null> {
  const file = indexPath(store);
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw new CliError(2, `cannot read ${file}: ${msgOf(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError(2, `index.json is corrupted — fix or restore ${file}`);
  }
  if (Array.isArray(data)) return data;
  if (isIndex(data)) return data;
  throw new CliError(2, `index.json is corrupted — fix or restore ${file}`);
}

function isIndex(data: unknown): data is StoreIndex {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.version === 2 && Array.isArray(d.skills) && d.skills.every(isRecord);
}

function isRecord(r: unknown): boolean {
  if (typeof r !== "object" || r === null) return false;
  const e = r as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.dir === "string" &&
    typeof e.current === "string" &&
    typeof e.versions === "object" &&
    e.versions !== null &&
    typeof e.source === "object" &&
    e.source !== null
  );
}

export function emptyIndex(): StoreIndex {
  return { version: 2, skills: [] };
}

export async function saveIndex(store: string, index: StoreIndex): Promise<void> {
  index.skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  await fsp.mkdir(store, { recursive: true }).catch((err) => {
    throw new CliError(2, `cannot create store directory ${store}: ${msgOf(err)}`);
  });
  const file = lockPath(store);
  const mine: LockInfo = { pid: process.pid, host: os.hostname(), at: now() };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await fsp.open(file, "wx");
      await fh.writeFile(JSON.stringify(mine));
      await fh.close();
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") {
        throw new CliError(2, `cannot create ${file}: ${msgOf(err)}`);
      }
    }
    let holder: LockInfo | null = null;
    try {
      holder = JSON.parse(await fsp.readFile(file, "utf8")) as LockInfo;
    } catch {
      holder = null;
    }
    if (holder && holder.host === os.hostname() && typeof holder.pid === "number" && !pidAlive(holder.pid)) {
      await fsp.rm(file, { force: true });
      continue;
    }
    if (holder && holder.host === os.hostname() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const who = holder ? `${holder.pid}@${holder.host}` : "an unknown process";
    throw new CliError(2, `index.lock held by ${who}; delete ${file} if no skill-library is running`);
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Versions and content
// ---------------------------------------------------------------------------

export function findRecord(index: StoreIndex, id: string): StoreRecord | undefined {
  return index.skills.find((r) => r.id === id);
}

/** Version key for content: git → 12 hex of the commit, local → "h-" + 12 hex of the hash. */
export function versionKeyFor(record: StoreRecord | undefined, info: { commit?: string; hash: string }): string {
  const full = info.commit ?? hexOf(info.hash);
  const prefix = info.commit ? "" : "h-";
  for (const len of [12, 16, 24, full.length]) {
    const key = `${prefix}${full.slice(0, len)}`;
    const existing = record?.versions[key];
    if (!existing || sameVersion(existing, info)) return key;
  }
  return `${prefix}${full}`;
}

export function sameVersion(v: VersionInfo, info: { commit?: string; hash: string }): boolean {
  if (info.commit !== undefined) return v.commit === info.commit && v.hash === info.hash;
  return v.commit === undefined && v.hash === info.hash;
}

/** The version a pin (commit for git, hash for local) points at, if it is in the record. */
export function findVersion(record: StoreRecord, pin: { commit?: string; hash?: string }): string | undefined {
  for (const [key, v] of Object.entries(record.versions)) {
    if (pin.commit !== undefined) {
      if (v.commit === pin.commit && (pin.hash === undefined || v.hash === pin.hash)) return key;
    } else if (pin.hash !== undefined && v.commit === undefined && v.hash === pin.hash) {
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

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
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
  for (const e of entries) {
    if (SKIP_BASENAMES.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
    else warn(`skipped non-regular file: ${s}`);
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

/** Repair: swap a staged copy over an existing version folder, rolling back on failure. */
export async function replaceVersionDir(staged: string, dest: string): Promise<void> {
  const backup = `${dest}.old-${randomBytes(4).toString("hex")}`;
  let hadOld = false;
  try {
    try {
      await fsp.rename(dest, backup);
      hadOld = true;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(staged, dest);
    } catch (err) {
      if (hadOld) await fsp.rename(backup, dest).catch(() => {});
      throw err;
    }
    if (hadOld) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
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
