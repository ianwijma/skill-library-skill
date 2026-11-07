import path from "node:path";
import { CliError, note } from "../lib/cli.ts";
import { loadProject, mutateManifest } from "../lib/manifest.ts";
import { openIndex } from "../lib/migrate.ts";
import { removeDir } from "../lib/store.ts";
import {
  ctxOf,
  mutateIndex,
  projectSkills,
  resolveSelectors,
  storeSkills,
  subtractAgents,
  validateAgents,
  type BaseOptions,
  type ScopedSkill,
} from "./context.ts";

export interface RemoveOptions extends BaseOptions {
  /** Remove from the store (`-g`) instead of the project's references. */
  global?: boolean;
  /** Remove only these agents from the skill's agent list. */
  agents?: string[];
  /** Remove every skill in scope. */
  all?: boolean;
  /** CLI hook: pick one id when a name matches several skills (return null to skip it). */
  chooseAmbiguous?: (selector: string, ids: string[]) => Promise<string | null>;
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
  const project = opts.global ? null : await loadProject(ctx.cwd);
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
  const nameOf = new Map(inScope.map((s) => [s.id, s.name]));
  const notes: string[] = [];
  let ids: string[];
  let unmatched: string[] = [];
  if (opts.all || selectors.includes("*")) ids = inScope.map((s) => s.id);
  else {
    ({ ids, unmatched } = await resolveSelectors(inScope, selectors, opts.chooseAmbiguous));
    if (!global && unmatched.length > 0) {
      const globals = await storeSkills(ctx.store, index, false);
      for (const sel of unmatched) {
        const hit = await resolveSelectors(globals, [sel], async () => null);
        if (hit.ids.length > 0 || globals.some((g) => g.name === sel)) notes.push(`${sel} is global; use -g`);
      }
    }
  }

  const removed: RemovedRow[] = [];
  if (ids.length === 0) return { removed, unmatched, notes };

  if (global) {
    const referenced = project && project.exists ? new Set(Object.keys(project.manifest.skills)) : new Set<string>();
    await mutateIndex(ctx.store, async (idx) => {
      for (const id of ids) {
        const record = idx.skills.find((r) => r.id === id);
        if (!record) continue;
        const name = nameOf.get(id) ?? id;
        if (agentsToRemove) {
          const r = subtractAgents(record.agents, agentsToRemove);
          if (r.kind === "all") {
            removed.push({ id, name, scope: "global", action: "kept", message: `${name} is available to all agents; remove it without -a` });
            continue;
          }
          if (r.kind === "rest") {
            record.agents = r.value;
            removed.push({ id, name, scope: "global", action: "agents" });
            continue;
          }
        }
        idx.skills.splice(idx.skills.indexOf(record), 1);
        await removeDir(path.join(ctx.store, record.dir));
        removed.push({
          id,
          name,
          scope: "global",
          action: "removed",
          ...(referenced.has(id) ? { message: `${name} is still referenced by ${project!.file}; run skill-library install to fetch it again` } : {}),
        });
      }
    });
  } else {
    await mutateManifest(project!, (manifest) => {
      for (const id of ids) {
        const entry = manifest.skills[id];
        if (!entry) continue;
        const name = nameOf.get(id) ?? entry.name ?? id;
        if (agentsToRemove) {
          const r = subtractAgents(entry.agents, agentsToRemove);
          if (r.kind === "all") {
            removed.push({ id, name, scope: "project", action: "kept", message: `${name} is available to all agents; remove it without -a` });
            continue;
          }
          if (r.kind === "rest") {
            entry.agents = r.value;
            removed.push({ id, name, scope: "project", action: "agents" });
            continue;
          }
        }
        delete manifest.skills[id];
        removed.push({ id, name, scope: "project", action: "removed" });
      }
    });
  }
  return { removed, unmatched, notes };
}
