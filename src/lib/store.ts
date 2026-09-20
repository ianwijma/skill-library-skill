import { promises as fsp } from "node:fs";
import path from "node:path";
import { CliError, msgOf, type Globals } from "./cli.ts";
import { contentFilePath, indexPath } from "./paths.ts";

export interface IndexEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  addedAt: string;
  updatedAt: string;
  contentFile: string;
}

export interface OutRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  content?: string;
}

export async function loadIndex(store: string): Promise<IndexEntry[]> {
  const file = indexPath(store);
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw new CliError(2, `cannot read ${file}: ${msgOf(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError(2, `index.json is corrupted — fix or restore ${file}`);
  }
  if (!Array.isArray(data) || !data.every(isValidEntry)) {
    throw new CliError(2, `index.json is corrupted — fix or restore ${file}`);
  }
  return data as IndexEntry[];
}

function isValidEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.name === "string" && typeof e.description === "string" && typeof e.contentFile === "string";
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export async function saveIndex(store: string, entries: IndexEntry[]): Promise<void> {
  await writeFileAtomic(indexPath(store), `${JSON.stringify(entries, null, 2)}\n`);
}

export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  try {
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

export async function removeFile(file: string): Promise<void> {
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (!isEnoent(err)) throw new CliError(2, `cannot delete ${file}: ${msgOf(err)}`);
  }
}

export function findEntry(index: IndexEntry[], id: string): IndexEntry {
  const entry = index.find((e) => e.id === id);
  if (!entry) throw new CliError(1, `unknown skill id '${id}'`);
  return entry;
}

export async function readContent(store: string, entry: IndexEntry): Promise<string | undefined> {
  const file = contentFilePath(store, entry.contentFile);
  try {
    return await fsp.readFile(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw new CliError(2, `cannot read ${file}: ${msgOf(err)}`);
  }
}

export async function projection(entry: IndexEntry, globals: Globals): Promise<OutRecord> {
  const record: OutRecord = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    path: contentFilePath(globals.store, entry.contentFile),
  };
  if (globals.returnContent) {
    const content = await readContent(globals.store, entry);
    if (content !== undefined) record.content = content;
  }
  return record;
}

export async function resolveSourceFile(raw: string): Promise<string> {
  const { resolve } = await import("node:path");
  const abs = resolve(raw);
  try {
    const s = await fsp.stat(abs);
    if (!s.isFile()) throw new Error("not a file");
    return abs;
  } catch {
    throw new CliError(1, `--path not found: ${abs}`);
  }
}

export async function readSourceFile(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    throw new CliError(1, `--path not readable: ${file}`);
  }
}
