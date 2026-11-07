import { promises as fsp } from "node:fs";
import path from "node:path";
import { CliError, msgOf, note } from "./cli.ts";
import { hashSkillDir } from "./hash.ts";
import { localSkillId, skillDirFor } from "./ids.ts";
import { indexPath } from "./paths.ts";
import {
  commitVersionDir,
  copySkill,
  emptyIndex,
  readRawIndex,
  saveIndex,
  stagingDir,
  versionKeyFor,
  withLock,
  type StoreIndex,
  type StoreRecord,
} from "./store.ts";

interface V1Entry {
  id: string;
  name: string;
  description: string;
  source?: string;
  addedAt?: string;
  updatedAt?: string;
  contentDir: string;
}

/** Names that belong to the gateway or the retired helper skills; never stored. */
export function isReservedSkillName(name: string): boolean {
  return name === "skill-library" || name.startsWith("skill-library-") || name === "skill-importer" || name === "skill-importer-undo";
}

function isV1Entry(e: unknown): e is V1Entry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.name === "string" && typeof r.description === "string" && typeof r.contentDir === "string";
}

/** Load the store index, migrating a v1 index on first use. */
export async function openIndex(store: string): Promise<StoreIndex> {
  const raw = await readRawIndex(store);
  if (raw === null) return emptyIndex();
  if (!Array.isArray(raw)) return raw;
  return withLock(store, async () => {
    const again = await readRawIndex(store);
    if (again === null) return emptyIndex();
    if (!Array.isArray(again)) return again;
    return migrateV1(store, again);
  });
}

async function sourceKind(src: string): Promise<"folder" | "file"> {
  try {
    const st = await fsp.stat(src);
    return st.isFile() ? "file" : "folder";
  } catch {
    return /\.md$/i.test(src) ? "file" : "folder";
  }
}

/** Caller holds the lock. Copies content first, writes the v2 index last, then deletes v1 folders. */
export async function migrateV1(store: string, entries: unknown[]): Promise<StoreIndex> {
  if (!entries.every(isV1Entry)) {
    throw new CliError(2, `index.json is corrupted — fix or restore ${indexPath(store)}`);
  }
  await fsp.copyFile(indexPath(store), path.join(store, "index.v1.json"));

  const index = emptyIndex();
  const dropped: string[] = [];
  const staged: string[] = [];
  const latest = new Map<string, string>();
  try {
    for (const e of entries) {
      if (isReservedSkillName(e.name)) {
        dropped.push(e.name);
        continue;
      }
      const oldDir = path.resolve(store, e.contentDir);
      const src = e.source && e.source.trim() !== "" ? path.resolve(e.source) : oldDir;
      const kind = await sourceKind(src);
      const id = localSkillId(src, null);
      const tmp = await stagingDir(store);
      staged.push(tmp);
      await copySkill(oldDir, tmp, "folder");
      const hash = await hashSkillDir(tmp);
      let record: StoreRecord | undefined = index.skills.find((r) => r.id === id);
      const at = e.addedAt ?? new Date().toISOString();
      const updated = e.updatedAt ?? at;
      if (!record) {
        record = {
          id,
          source: { type: kind, url: src, ref: null, path: "" },
          dir: skillDirFor(id, e.name),
          versions: {},
          current: "",
          global: true,
          agents: "all",
          addedAt: at,
          updatedAt: updated,
        };
        index.skills.push(record);
      }
      const key = versionKeyFor(record, { hash });
      if (!record.versions[key]) {
        record.versions[key] = { hash, name: e.name, description: e.description, addedAt: at };
        await commitVersionDir(tmp, path.join(store, record.dir, key));
      } else {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
      const prev = latest.get(id);
      if (prev === undefined || updated >= prev) {
        latest.set(id, updated);
        record.current = key;
        record.updatedAt = updated;
      }
    }
    await saveIndex(store, index);
  } catch (err) {
    for (const r of index.skills) await fsp.rm(path.join(store, r.dir), { recursive: true, force: true }).catch(() => {});
    for (const t of staged) await fsp.rm(t, { recursive: true, force: true }).catch(() => {});
    throw new CliError(2, `migration of ${indexPath(store)} failed; the old store is untouched: ${msgOf(err)}`);
  }

  // Commit point passed: remove the v1 content folders (best effort).
  for (const e of entries) {
    const oldDir = path.resolve(store, e.contentDir);
    if (index.skills.some((r) => path.resolve(store, r.dir) === oldDir)) continue;
    await fsp.rm(oldDir, { recursive: true, force: true }).catch(() => {});
  }
  if (dropped.length > 0) note(`Dropped old skill-library helper skills from the store: ${dropped.join(", ")}`);
  note(`Migrated ${index.skills.length} skills to the new store format. Run skill-library add <any source> once to install the new gateway.`);
  return index;
}
