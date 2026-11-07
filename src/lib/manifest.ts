import { promises as fsp, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CliError, msgOf } from "./cli.ts";
import { isEnoent, withFileLock, writeFileAtomic, type AgentsValue } from "./store.ts";

export const MANIFEST = "skill-library.json";

export interface ManifestEntry {
  /** Skill name (frontmatter), so a missing skill still shadows same-name global skills. */
  name?: string;
  /** Clone URL (git), "~/…" or absolute path (home/path). Absent for local:// entries. */
  source?: string;
  ref?: string | null;
  path?: string;
  commit?: string;
  hash?: string;
  agents: AgentsValue;
}

export interface Manifest {
  version: 1;
  skills: Record<string, ManifestEntry>;
}

export interface Project {
  root: string;
  file: string;
  manifest: Manifest;
  /** Whether skill-library.json exists on disk. */
  exists: boolean;
}

/**
 * Project root: nearest ancestor of `cwd` with skill-library.json; if none, `cwd` itself.
 * `$HOME` is never a project root (returns null → global scope).
 */
export function findProjectRoot(cwd: string): { root: string; exists: boolean } | null {
  const home = path.resolve(homedir());
  let dir = path.resolve(cwd);
  for (;;) {
    if (dir !== home && fileExistsSync(path.join(dir, MANIFEST))) return { root: dir, exists: true };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const start = path.resolve(cwd);
  if (start === home) return null;
  return { root: start, exists: false };
}

function fileExistsSync(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function loadProject(cwd: string): Promise<Project | null> {
  const found = findProjectRoot(cwd);
  if (!found) return null;
  const file = path.join(found.root, MANIFEST);
  if (!found.exists) return { root: found.root, file, manifest: { version: 1, skills: {} }, exists: false };
  return { root: found.root, file, manifest: await readManifest(file), exists: true };
}

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256-[0-9a-f]{64}$/;

/** A relative POSIX path that stays inside its base ("" and "." allowed). */
export function isContainedRelPath(p: string): boolean {
  if (p === "" || p === ".") return true;
  if (p.startsWith("/") || p.includes("\\") || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split("/").some((seg) => seg === ".." || seg === "");
}

function bad(file: string, id: string, why: string): never {
  throw new CliError(1, `${file}: invalid entry "${id}": ${why}`);
}

/** Validate one entry; throws a usage error naming the entry. */
export function validateEntry(file: string, id: string, raw: unknown): ManifestEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(file, id, "not an object");
  const e = raw as Record<string, unknown>;
  const agents = e.agents === undefined ? "all" : e.agents;
  if (agents !== "all" && !(Array.isArray(agents) && agents.length > 0 && agents.every((a) => typeof a === "string" && /^[a-z0-9-]+$/.test(a)))) {
    bad(file, id, 'agents must be "all" or a list of agent ids');
  }
  if (e.name !== undefined && (typeof e.name !== "string" || e.name.trim() === "")) bad(file, id, "name must be a string");
  const out: ManifestEntry = { agents: agents as AgentsValue, ...(typeof e.name === "string" ? { name: e.name } : {}) };
  if (id.startsWith("local://")) {
    if (!isContainedRelPath(id.slice("local://".length))) bad(file, id, "local:// path must stay inside the project");
    return out;
  }
  const source = e.source;
  if (typeof source !== "string" || source.trim() === "" || source.startsWith("-")) bad(file, id, "source is required");
  if (typeof e.hash !== "string" || !HASH.test(e.hash)) bad(file, id, "hash must be sha256-<64 hex>");
  out.source = source;
  out.hash = e.hash;
  if (id.startsWith("repo://")) {
    if (typeof e.commit !== "string" || !SHA.test(e.commit)) bad(file, id, "commit must be a full 40-hex commit SHA");
    if (e.path !== undefined && (typeof e.path !== "string" || !isContainedRelPath(e.path))) bad(file, id, "path must be a relative path inside the repository");
    if (e.ref !== undefined && e.ref !== null && (typeof e.ref !== "string" || e.ref.startsWith("-") || e.ref === "")) bad(file, id, "ref must be a branch/tag name or null");
    if (/^ext::/i.test(source)) bad(file, id, "unsupported git transport");
    out.commit = e.commit;
    out.path = (e.path as string | undefined) ?? "";
    out.ref = (e.ref as string | null | undefined) ?? null;
    return out;
  }
  if (id.startsWith("home://") || id.startsWith("path://")) {
    if (e.commit !== undefined) bad(file, id, "folder entries have no commit");
    return out;
  }
  bad(file, id, "unknown id prefix (expected repo://, local://, home:// or path://)");
}

export async function readManifest(file: string): Promise<Manifest> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { version: 1, skills: {} };
    throw new CliError(2, `cannot read ${file}: ${msgOf(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError(1, `${file} is not valid JSON`);
  }
  const d = data as Partial<Manifest>;
  if (typeof d !== "object" || d === null || d.version !== 1 || typeof d.skills !== "object" || d.skills === null || Array.isArray(d.skills)) {
    throw new CliError(1, `${file} is not a skill-library.json (version 1)`);
  }
  const skills: Record<string, ManifestEntry> = {};
  for (const [id, entry] of Object.entries(d.skills)) skills[id] = validateEntry(file, id, entry);
  return { version: 1, skills };
}

function serialize(manifest: Manifest): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(manifest.skills).sort()) {
    const e = manifest.skills[key]!;
    const ordered: Record<string, unknown> = {};
    for (const k of ["name", "source", "ref", "path", "commit", "hash", "agents"] as const) {
      if (e[k] !== undefined) ordered[k] = e[k];
    }
    sorted[key] = ordered;
  }
  return `${JSON.stringify({ version: 1, skills: sorted }, null, 2)}\n`;
}

/**
 * Read-modify-write skill-library.json under its own lock, re-reading the file so concurrent
 * commands never lose each other's entries. `fn` mutates the fresh manifest; return false to skip writing.
 */
export async function mutateManifest<T>(project: Project, fn: (manifest: Manifest) => T | Promise<T>): Promise<T> {
  return withFileLock(`${project.file}.lock`, async () => {
    const fresh = await readManifest(project.file);
    const out = await fn(fresh);
    await writeFileAtomic(project.file, serialize(fresh));
    project.manifest = fresh;
    project.exists = true;
    return out;
  });
}
