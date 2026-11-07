import path from "node:path";
import { CliError, note } from "../lib/cli.ts";
import { filterSkills } from "../lib/discover.ts";
import { loadProject, saveManifest } from "../lib/manifest.ts";
import { removeDir } from "../lib/store.ts";
import { ctxOf, mutateIndex, projectSkills, storeSkills, subtractAgents, validateAgents, type BaseOptions, type ScopedSkill } from "./context.ts";
import { openIndex } from "../lib/migrate.ts";

export interface RemoveOptions extends BaseOptions {
  /** Remove from the store (`-g`) instead of the project's references. */
  global?: boolean;
  /** Remove only these agents from the skill's agent list. */
  agents?: string[];
  /** Remove every skill in scope. */
  all?: boolean;
}

export interface RemovedRow {
  id: string;
  name: string;
  scope: "project" | "global";
  /** removed = reference/skill gone; agents = only the agent list changed; kept = nothing done. */
  action: "removed" | "agents" | "kept";
  message?: string;
}

export interface RemoveResult {
  removed: RemovedRow[];
  /** Selectors that matched nothing in scope. */
  unmatched: string[];
  /** Notes such as "x is global; use -g". */
  notes: string[];
}

/** Skills in the scope `remove` works on (used for the interactive picker too). */
export async function removableSkills(opts: RemoveOptions = {}): Promise<ScopedSkill[]> {
  const ctx = ctxOf(opts);
  const index = await openIndex(ctx.store);
  if (opts.global) return storeSkills(ctx.store, index, true);
  const project = await loadProject(ctx.cwd);
  if (!project) return storeSkills(ctx.store, index, true);
  return projectSkills(ctx.store, index, project);
}

export async function removeSkills(selectors: string[], opts: RemoveOptions = {}): Promise<RemoveResult> {
  const ctx = ctxOf(opts);
  if (opts.all && selectors.length > 0) {
    throw new CliError(1, "Cannot combine --all with specific skill names.", "Use `skill-library remove --all` to remove every skill, or omit --all to remove only the named skills.");
  }
  if (opts.agents) validateAgents(opts.agents);
  const agentsToRemove = opts.agents && !opts.agents.includes("*") ? opts.agents : undefined;
  const index = await openIndex(ctx.store);
  const project = await loadProject(ctx.cwd);
  const global = !!opts.global || !project;
  if (!opts.global && !project) note("No project here; using global scope.");

  const inScope = global ? await storeSkills(ctx.store, index, true) : await projectSkills(ctx.store, index, project!);
  const pick = (sel: string): ScopedSkill[] => [...inScope.filter((s) => s.id === sel), ...filterSkills(inScope, [sel])].filter((s, i, a) => a.indexOf(s) === i);

  let chosen: ScopedSkill[];
  const unmatched: string[] = [];
  const notes: string[] = [];
  if (opts.all || selectors.includes("*")) chosen = inScope;
  else {
    chosen = [];
    for (const sel of selectors) {
      const hit = pick(sel);
      if (hit.length === 0) {
        unmatched.push(sel);
        if (!global) {
          const globals = await storeSkills(ctx.store, index, false);
          if (globals.some((g) => g.id === sel || filterSkills([g], [sel]).length > 0)) notes.push(`${sel} is global; use -g`);
        }
      }
      for (const h of hit) if (!chosen.includes(h)) chosen.push(h);
    }
  }

  const removed: RemovedRow[] = [];
  if (global) {
    const referenced = project && project.exists ? new Set(Object.keys(project.manifest.skills)) : new Set<string>();
    if (chosen.length > 0) {
      await mutateIndex(ctx.store, async (idx) => {
        for (const s of chosen) {
          const record = idx.skills.find((r) => r.id === s.id);
          if (!record) continue;
          if (agentsToRemove) {
            const r = subtractAgents(record.agents, agentsToRemove);
            if (r.kind === "all") {
              removed.push({ id: s.id, name: s.name, scope: "global", action: "kept", message: `${s.name} is available to all agents; remove it without -a` });
              continue;
            }
            if (r.kind === "rest") {
              record.agents = r.value;
              removed.push({ id: s.id, name: s.name, scope: "global", action: "agents" });
              continue;
            }
          }
          idx.skills.splice(idx.skills.indexOf(record), 1);
          await removeDir(path.join(ctx.store, record.dir));
          removed.push({
            id: s.id,
            name: s.name,
            scope: "global",
            action: "removed",
            ...(referenced.has(s.id) ? { message: `${s.name} is still referenced by ${project!.file}; run skill-library install to fetch it again` } : {}),
          });
        }
      });
    }
  } else {
    const entries = project!.manifest.skills;
    for (const s of chosen) {
      const entry = entries[s.id];
      if (!entry) continue;
      if (agentsToRemove) {
        const r = subtractAgents(entry.agents, agentsToRemove);
        if (r.kind === "all") {
          removed.push({ id: s.id, name: s.name, scope: "project", action: "kept", message: `${s.name} is available to all agents; remove it without -a` });
          continue;
        }
        if (r.kind === "rest") {
          entry.agents = r.value;
          removed.push({ id: s.id, name: s.name, scope: "project", action: "agents" });
          continue;
        }
      }
      delete entries[s.id];
      removed.push({ id: s.id, name: s.name, scope: "project", action: "removed" });
    }
    if (removed.some((r) => r.action !== "kept")) await saveManifest(project!);
  }
  return { removed, unmatched, notes };
}
