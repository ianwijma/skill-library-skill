// Skill discovery, ported from vercel-labs/skills v1.7.6 src/skills.ts (MIT): the same
// priority directories, container depth and recursive fallback. Plugin manifests,
// skills.sh.json paths and the source repo's own lock are not consulted in 0.1.0.
import { promises as fsp } from "node:fs";
import path from "node:path";
import { CliError, sanitizeMetadata, warn } from "./cli.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { isReservedSkillName } from "./migrate.ts";
import { getAgents } from "./agents.ts";

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Absolute skill folder (or the .md file itself for file sources). */
  path: string;
  kind: "folder" | "file";
  rawContent: string;
}

const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "__pycache__"];
const CONTAINER_DEPTH = 3;
const LEGACY_DIRS = [".cline/skills", ".codex/skills", ".factory/skills", ".github/skills", ".kilo/skills", ".kilocode/skills", ".opencode/skills", ".pi/skills"];

function agentProjectDirs(): string[] {
  const dirs = new Set<string>([...Object.values(getAgents()).map((a) => a.skillsDir), ...LEGACY_DIRS]);
  return [...dirs].filter((d) => d !== "skills").sort();
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, "-");
}

/** Parse a SKILL.md (or markdown file); null when it lacks a usable name/description. */
export async function parseSkillFile(file: string, kind: "folder" | "file", quiet = false): Promise<DiscoveredSkill | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (!quiet) warn(`Skipped ${file}: failed to read file: ${(err as Error).message}`);
    return null;
  }
  let data: Record<string, unknown>;
  try {
    ({ data } = parseFrontmatter(raw));
  } catch (err) {
    if (!quiet) warn(`Skipped ${file}: YAML parse error: ${(err as Error).message}`);
    return null;
  }
  if (typeof data.name !== "string" || typeof data.description !== "string") {
    if (!quiet) warn(`Skipped ${file}: missing required frontmatter field(s): name, description`);
    return null;
  }
  const name = sanitizeMetadata(data.name);
  const description = sanitizeMetadata(data.description);
  if (!name || !description) {
    if (!quiet) warn(`Skipped ${file}: empty required frontmatter field(s)`);
    return null;
  }
  const metadata = typeof data.metadata === "object" && data.metadata !== null ? (data.metadata as Record<string, unknown>) : undefined;
  if (metadata?.internal === true && process.env.INSTALL_INTERNAL_SKILLS !== "1" && process.env.INSTALL_INTERNAL_SKILLS !== "true") {
    return null;
  }
  return { name, description, path: kind === "file" ? file : path.dirname(file), kind, rawContent: raw };
}

/**
 * A staged copy must hold a regular SKILL.md with usable frontmatter (the copier skips symlinks,
 * so a linked SKILL.md would otherwise produce an empty version). Throws otherwise.
 */
export async function requireStagedSkill(staged: string, label: string, fallback?: { name: string; description: string }): Promise<{ name: string; description: string }> {
  const file = path.join(staged, "SKILL.md");
  let st;
  try {
    st = await fsp.lstat(file);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) throw new CliError(1, `${label}: SKILL.md is missing or not a regular file (symlinks are not copied)`);
  const parsed = await parseSkillFile(file, "folder", true);
  if (parsed) return { name: parsed.name, description: parsed.description };
  if (fallback) return fallback;
  throw new CliError(1, `${label}: SKILL.md has no usable name/description frontmatter`);
}

async function findSkillDirs(dir: string, depth = 0, maxDepth = 5): Promise<string[]> {
  if (depth > maxDepth) return [];
  const here = (await isFile(path.join(dir, "SKILL.md"))) ? [dir] : [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return here;
  }
  const subs = await Promise.all(
    entries.filter((e) => e.isDirectory() && !SKIP_DIRS.includes(e.name)).map((e) => findSkillDirs(path.join(dir, e.name), depth + 1, maxDepth)),
  );
  return [...here, ...subs.flat()];
}

export interface DiscoverOptions {
  fullDepth?: boolean;
  /** Keep the gateway and retired helper skills (used by `use`). */
  includeReserved?: boolean;
}

/**
 * Discover skills under `base` (+ `subpath`). Unlike vercel, two different folders that
 * declare the same name are an error, because a skill's id must be unique.
 */
export async function discoverSkills(base: string, subpath?: string, opts: DiscoverOptions = {}): Promise<{ skills: DiscoveredSkill[]; reserved: DiscoveredSkill[] }> {
  if (subpath) {
    const target = path.resolve(base, subpath);
    if (target !== path.resolve(base) && !target.startsWith(path.resolve(base) + path.sep)) {
      throw new CliError(1, `Subpath escapes the repository: ${subpath}`);
    }
  }
  const searchPath = subpath ? path.join(base, subpath) : base;
  const found: DiscoveredSkill[] = [];
  const parsed = new Set<string>();

  const parseAt = async (dir: string): Promise<DiscoveredSkill | null> => {
    const file = path.resolve(dir, "SKILL.md");
    if (parsed.has(file)) return null;
    parsed.add(file);
    if (!(await isFile(file))) return null;
    return parseSkillFile(file, "folder");
  };
  const add = (s: DiscoveredSkill | null): boolean => {
    if (!s) return false;
    found.push(s);
    return true;
  };

  if (await isFile(path.join(searchPath, "SKILL.md"))) {
    const s = await parseAt(searchPath);
    if (add(s) && !opts.fullDepth) return split(found, opts);
  }

  const priority = [
    searchPath,
    path.join(searchPath, "skills"),
    path.join(searchPath, "skills/.curated"),
    path.join(searchPath, "skills/.experimental"),
    path.join(searchPath, "skills/.system"),
    ...agentProjectDirs().map((d) => path.join(searchPath, d)),
  ];
  const deep = new Set(priority.slice(1));

  const walk = async (dir: string, maxDepth: number, depth = 1): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      const hasSkill = await isFile(path.join(child, "SKILL.md"));
      if (hasSkill) add(await parseAt(child));
      if (hasSkill || depth >= maxDepth || SKIP_DIRS.includes(e.name)) continue;
      await walk(child, maxDepth, depth + 1);
    }
  };
  for (const dir of priority) await walk(dir, deep.has(dir) ? CONTAINER_DEPTH : 1);

  if (found.length === 0 || opts.fullDepth) {
    for (const dir of await findSkillDirs(searchPath)) add(await parseAt(dir));
  }
  return split(found, opts);
}

function split(found: DiscoveredSkill[], opts: DiscoverOptions): { skills: DiscoveredSkill[]; reserved: DiscoveredSkill[] } {
  const reserved = opts.includeReserved ? [] : found.filter((s) => isReservedSkillName(s.name));
  const skills = opts.includeReserved ? found : found.filter((s) => !isReservedSkillName(s.name));
  const byName = new Map<string, DiscoveredSkill[]>();
  for (const s of skills) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  const dupes = [...byName.entries()].filter(([, list]) => list.length > 1);
  if (dupes.length > 0) {
    const lines = dupes.flatMap(([name, list]) => [`  ${name}:`, ...list.map((s) => `    - ${s.path}`)]);
    throw new CliError(1, ["Several folders declare the same skill name:", ...lines].join("\n"), "Rename one of them, or add the folder you want directly.");
  }
  return { skills, reserved };
}

/** vercel's filterSkills: exact (case-insensitive) name match, else slug match. */
export function filterSkills<T extends { name: string }>(skills: T[], names: string[]): T[] {
  const selected = new Set<T>();
  for (const input of names) {
    const exact = skills.filter((s) => s.name.toLowerCase() === input.toLowerCase());
    const matches = exact.length ? exact : skills.filter((s) => normalizeName(s.name) === normalizeName(input));
    for (const s of matches) selected.add(s);
  }
  return skills.filter((s) => selected.has(s));
}
