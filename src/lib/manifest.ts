import { promises as fsp, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CliError, msgOf } from "./cli.ts";
import { isEnoent, writeFileAtomic, type AgentsValue } from "./store.ts";

export const MANIFEST = "skill-library.json";

export interface ManifestEntry {
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
  if (typeof d !== "object" || d === null || d.version !== 1 || typeof d.skills !== "object" || d.skills === null) {
    throw new CliError(1, `${file} is not a skill-library.json (version 1)`);
  }
  for (const entry of Object.values(d.skills)) {
    if (typeof entry !== "object" || entry === null) throw new CliError(1, `${file} has an invalid entry`);
    if (entry.agents === undefined) entry.agents = "all";
  }
  return d as Manifest;
}

export async function saveManifest(project: Project): Promise<void> {
  const sorted: Record<string, ManifestEntry> = {};
  for (const key of Object.keys(project.manifest.skills).sort()) {
    const e = project.manifest.skills[key]!;
    const ordered: Record<string, unknown> = {};
    for (const k of ["source", "ref", "path", "commit", "hash", "agents"] as const) {
      if (e[k] !== undefined) ordered[k] = e[k];
    }
    sorted[key] = ordered as unknown as ManifestEntry;
  }
  const out = { version: 1, skills: sorted };
  await writeFileAtomic(project.file, `${JSON.stringify(out, null, 2)}\n`);
  project.exists = true;
}
