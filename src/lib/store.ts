import { promises as fsp } from "node:fs";
import path from "node:path";
import { CliError, msgOf, warn, type Globals } from "./cli.ts";
import { entryFilePath, indexPath, skillDirPath } from "./paths.ts";

export interface IndexEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  addedAt: string;
  updatedAt: string;
  contentDir: string;
}

export interface OutRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  dir: string;
  content?: string;
}

const SKIP_BASENAMES = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);

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
  return typeof e.id === "string" && typeof e.name === "string" && typeof e.description === "string" && typeof e.contentDir === "string";
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

export function findEntry(index: IndexEntry[], id: string): IndexEntry {
  const entry = index.find((e) => e.id === id);
  if (!entry) throw new CliError(1, `unknown skill id '${id}'`);
  return entry;
}

export async function readContent(store: string, entry: IndexEntry): Promise<string | undefined> {
  const file = entryFilePath(store, entry.contentDir);
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
    path: entryFilePath(globals.store, entry.contentDir),
    dir: skillDirPath(globals.store, entry.contentDir),
  };
  if (globals.returnContent) {
    const content = await readContent(globals.store, entry);
    if (content !== undefined) record.content = content;
  }
  return record;
}

export interface ResolvedSource {
  kind: "file" | "dir";
  abs: string;
}

export async function resolveSource(raw: string): Promise<ResolvedSource> {
  const abs = path.resolve(raw);
  let st: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    st = await fsp.stat(abs);
  } catch {
    throw new CliError(1, `--path not found: ${abs}`);
  }
  if (st.isFile()) {
    try {
      await fsp.access(abs, fsp.constants.R_OK);
    } catch {
      throw new CliError(1, `--path not readable: ${abs}`);
    }
    return { kind: "file", abs };
  }
  if (st.isDirectory()) {
    try {
      await fsp.access(entryFilePath(abs, ""), fsp.constants.R_OK);
    } catch {
      throw new CliError(1, `--path directory has no readable SKILL.md: ${abs}`);
    }
    return { kind: "dir", abs };
  }
  throw new CliError(1, `--path not a file or directory: ${abs}`);
}

export async function stageSkillDir(source: ResolvedSource, store: string, id: string): Promise<string> {
  const contentDir = `skills/${id}`;
  const dest = skillDirPath(store, contentDir);
  const tmp = `${dest}.tmp`;
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
    if (source.kind === "dir") {
      await copyTree(source.abs, tmp);
    } else {
      await fsp.mkdir(tmp, { recursive: true });
      await fsp.copyFile(source.abs, path.join(tmp, "SKILL.md"));
    }
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new CliError(2, `cannot import ${source.abs}: ${msgOf(err)}`);
  }
  return contentDir;
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
    else warn(`skipped non-regular file during import: ${s}`);
  }
}

export async function commitSkillDir(store: string, contentDir: string, replace = false): Promise<void> {
  const dest = skillDirPath(store, contentDir);
  const tmp = `${dest}.tmp`;
  try {
    await fsp.access(tmp);
  } catch {
    throw new CliError(2, `cannot write ${dest}: staged copy missing`);
  }
  try {
    if (replace) {
      const old = `${dest}.old`;
      await fsp.rm(old, { recursive: true, force: true });
      let hadOld = false;
      try {
        await fsp.rename(dest, old);
        hadOld = true;
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      try {
        await fsp.rename(tmp, dest);
      } catch (err) {
        if (hadOld) await fsp.rename(old, dest).catch(() => {});
        throw err;
      }
      if (hadOld) await fsp.rm(old, { recursive: true, force: true }).catch(() => {});
    } else {
      await fsp.rename(tmp, dest);
    }
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new CliError(2, `cannot write ${dest}: ${msgOf(err)}`);
  }
}

export async function listSkillFiles(store: string, entry: IndexEntry): Promise<string[]> {
  const root = skillDirPath(store, entry.contentDir);
  const files: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(relPath);
      else if (e.isFile()) files.push(relPath);
    }
  }
  try {
    await walk("");
  } catch {
    return [];
  }
  return files.sort();
}

export async function removeSkillDir(store: string, contentDir: string): Promise<void> {
  const dir = skillDirPath(store, contentDir);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (err) {
    throw new CliError(2, `cannot delete ${dir}: ${msgOf(err)}`);
  }
}
