import { promises as fsp } from "node:fs";
import path from "node:path";
import { agentIds } from "../lib/agents.ts";
import { CliError } from "../lib/cli.ts";
import { filterSkills, parseSkillFile } from "../lib/discover.ts";
import { gitSkillId } from "../lib/ids.ts";
import { loadProject, type ManifestEntry, type Project } from "../lib/manifest.ts";
import { resolveStore } from "../lib/paths.ts";
import {
  exists,
  findRecord,
  findVersion,
  openIndex,
  saveIndex,
  versionDir,
  withLock,
  type AgentsValue,
  type StoreIndex,
  type StoreRecord,
} from "../lib/store.ts";

export interface BaseOptions {
  /** Working directory used to find the project (default: process.cwd()). */
  cwd?: string;
  /** Store directory (default: $SKILL_LIBRARY_DIR or ~/.local/share/skill-library). */
  store?: string;
}

export interface Ctx {
  cwd: string;
  store: string;
}

export function ctxOf(opts: BaseOptions): Ctx {
  return { cwd: path.resolve(opts.cwd ?? process.cwd()), store: resolveStore(opts.store) };
}

/** Run `fn` on the index under the store lock and save it. */
export async function mutateIndex<T>(store: string, fn: (index: StoreIndex) => Promise<T>): Promise<T> {
  return withLock(store, async () => {
    const index = await openIndex(store);
    const out = await fn(index);
    await saveIndex(store, index);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Validate `-a` values; `'*'` means all agents. Returns "all" or the agent list. */
export function agentsArg(values: string[] | undefined, allowStar = true): AgentsValue {
  if (!values || values.length === 0) return "all";
  if (values.includes("*")) {
    if (!allowStar) throw new CliError(1, "Invalid agents: *", `Valid agents: ${agentIds().join(", ")}`);
    return "all";
  }
  validateAgents(values);
  return [...new Set(values)];
}

export function validateAgents(values: string[]): void {
  const valid = agentIds();
  const invalid = values.filter((v) => v !== "*" && !valid.includes(v));
  if (invalid.length > 0) throw new CliError(1, `Invalid agents: ${invalid.join(", ")}`, `Valid agents: ${valid.join(", ")}`);
}

/** §4: "all" absorbs additions; a first assignment takes the request as-is. */
export function mergeAgents(current: AgentsValue | undefined, requested: AgentsValue): AgentsValue {
  if (requested === "all" || current === "all") return "all";
  if (current === undefined) return requested;
  return [...new Set([...current, ...requested])];
}

export type SubtractResult = { kind: "all" } | { kind: "empty" } | { kind: "rest"; value: string[] };

export function subtractAgents(current: AgentsValue, remove: string[]): SubtractResult {
  if (current === "all") return { kind: "all" };
  const rest = current.filter((a) => !remove.includes(a));
  return rest.length === 0 ? { kind: "empty" } : { kind: "rest", value: rest };
}

export function agentsMatch(value: AgentsValue, agent: string | undefined): boolean {
  if (agent === undefined || value === "all") return true;
  return value.includes(agent);
}

// ---------------------------------------------------------------------------
// Scoped views of skills
// ---------------------------------------------------------------------------

export type Status = "installed" | "missing" | "untracked";

/**
 * Where a global skill's source of truth is (docs/09-global-sync-options.md):
 * - remote: a git repository it is updated from
 * - own: a `skills/` folder in the sync repository (synced to every machine)
 * - machine-only: a folder on this machine (never synced)
 */
export type GlobalKind = "remote" | "own" | "machine-only";

/** `syncUrl` is the sync repository's URL, or null when sync is not set up. */
export function globalKindOf(skill: { id: string; sourceType: "git" | "local" | null }, syncUrl: string | null): GlobalKind {
  if (skill.sourceType !== "git") return "machine-only";
  if (syncUrl !== null && skill.id.startsWith(gitSkillId(syncUrl, ""))) return "own";
  return "remote";
}

export interface ScopedSkill {
  id: string;
  name: string;
  description: string;
  scope: "project" | "global";
  /** local = read in place (local://); stored = lives in the store. */
  kind: "local" | "stored";
  record?: StoreRecord;
  versionKey?: string;
  entry?: ManifestEntry;
  /** Skill folder, or null when not installed. */
  dir: string | null;
  agents: AgentsValue;
  status: Status;
  /** Display source: the git URL, folder path or local:// path. */
  source: string;
  sourceType: "git" | "local" | null;
}

function nameFromId(id: string): string {
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? id;
}

/** Skills referenced by the project (manifest order: sorted by id). */
export async function projectSkills(store: string, index: StoreIndex, project: Project): Promise<ScopedSkill[]> {
  const out: ScopedSkill[] = [];
  for (const [id, entry] of Object.entries(project.manifest.skills)) {
    if (id.startsWith("local://")) {
      const rel = id.slice("local://".length);
      const dir = path.resolve(project.root, rel === "." ? "" : rel);
      const inside = dir === project.root || dir.startsWith(project.root + path.sep);
      const parsed = inside && (await exists(path.join(dir, "SKILL.md"))) ? await parseSkillFile(path.join(dir, "SKILL.md"), "folder", true) : null;
      out.push({
        id,
        name: parsed?.name ?? entry.name ?? nameFromId(id),
        description: parsed?.description ?? "",
        scope: "project",
        kind: "local",
        entry,
        dir: parsed ? dir : null,
        agents: entry.agents,
        status: parsed ? "installed" : "missing",
        source: id,
        sourceType: "local",
      });
      continue;
    }
    const record = findRecord(index, id);
    const key = record ? findVersion(record, { ...(entry.commit !== undefined ? { commit: entry.commit } : {}), ...(entry.hash !== undefined ? { hash: entry.hash } : {}) }) : undefined;
    const dir = record && key ? versionDir(store, record, key) : null;
    const present = dir !== null && (await exists(path.join(dir, "SKILL.md")));
    const meta = record && key ? record.versions[key] : undefined;
    out.push({
      id,
      name: meta?.name ?? entry.name ?? nameFromId(id),
      description: meta?.description ?? "",
      scope: "project",
      kind: "stored",
      ...(record ? { record } : {}),
      ...(key ? { versionKey: key } : {}),
      entry,
      dir: present ? dir : null,
      agents: entry.agents,
      status: present ? "installed" : "missing",
      source: entry.source ?? record?.source.url ?? id,
      sourceType: entry.commit !== undefined || record?.source.type === "git" ? "git" : "local",
    });
  }
  return out;
}

/** Store skills at their `current` version. Non-global records only when `includeHidden`. */
export async function storeSkills(store: string, index: StoreIndex, includeHidden: boolean): Promise<ScopedSkill[]> {
  const out: ScopedSkill[] = [];
  for (const record of index.skills) {
    if (!record.global && !includeHidden) continue;
    const meta = record.versions[record.current];
    const dir = versionDir(store, record, record.current);
    const present = meta !== undefined && (await exists(path.join(dir, "SKILL.md")));
    out.push({
      id: record.id,
      name: meta?.name ?? nameFromId(record.id),
      description: meta?.description ?? "",
      scope: "global",
      kind: "stored",
      record,
      versionKey: record.current,
      dir: present ? dir : null,
      agents: record.agents,
      status: !record.global ? "untracked" : present ? "installed" : "missing",
      source: record.source.url,
      sourceType: record.source.type === "git" ? "git" : "local",
    });
  }
  return out;
}

/**
 * Resolve selectors (ids or names) to distinct ids. A name that matches several ids is
 * ambiguous: `choose` (TTY picker) decides, otherwise it is an error listing the ids.
 * Unmatched selectors are returned separately. Nothing is mutated here.
 */
export async function resolveSelectors<T extends { id: string; name: string }>(
  items: T[],
  selectors: string[],
  choose?: (selector: string, ids: string[]) => Promise<string | null>,
): Promise<{ ids: string[]; unmatched: string[] }> {
  const ids: string[] = [];
  const unmatched: string[] = [];
  for (const sel of selectors) {
    const exact = items.filter((i) => i.id === sel);
    const byName = exact.length > 0 ? exact : filterSkills(items, [sel]);
    const distinct = [...new Set(byName.map((i) => i.id))];
    if (distinct.length === 0) {
      unmatched.push(sel);
      continue;
    }
    let id: string | null = distinct[0]!;
    if (distinct.length > 1) {
      id = choose ? await choose(sel, distinct) : null;
      if (id === null) {
        if (choose) continue;
        throw new CliError(1, `"${sel}" matches several skills:\n${distinct.map((d) => `  - ${d}`).join("\n")}`, "Pass the full id to pick one.");
      }
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unmatched };
}

export async function loadScope(opts: BaseOptions): Promise<{ ctx: Ctx; index: StoreIndex; project: Project | null }> {
  const ctx = ctxOf(opts);
  const index = await openIndex(ctx.store);
  const project = await loadProject(ctx.cwd);
  return { ctx, index, project };
}

export async function readText(file: string): Promise<string> {
  return fsp.readFile(file, "utf8");
}
