import path from "node:path";
import { CliError } from "../lib/cli.ts";
import { loadProject, mutateManifest, type Project } from "../lib/manifest.ts";
import { removeDir, openIndex } from "../lib/store.ts";
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
  /**
   * Drop the reference from the project's skill-library.json instead of deleting the skill from
   * the global library, which is the default. Fails when there is no skill-library.json.
   */
  project?: boolean;
  /** Delete from the global library (the default; kept so `-g` stays explicit). Cannot be combined with `project`. */
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
  if (!opts.project) return storeSkills(ctx.store, index, true);
  return projectSkills(ctx.store, index, await requireProject(ctx.cwd));
}

async function requireProject(cwd: string): Promise<Project> {
  const project = await loadProject(cwd);
  if (!project || !project.exists) {
    throw new CliError(1, "No skill-library.json here, so there is no project to remove from.", "Drop -p to remove from the global library.");
  }
  return project;
}

export async function removeSkills(selectors: string[], opts: RemoveOptions = {}): Promise<RemoveResult> {
  const ctx = ctxOf(opts);
  if (opts.all && selectors.length > 0) {
    throw new CliError(1, "Cannot combine --all with specific skill names.", "Use `skill-library remove --all` to remove every skill, or omit --all to remove only the named skills.");
  }
  if (opts.agents) validateAgents(opts.agents);
  const agentsToRemove = opts.agents && !opts.agents.includes("*") ? opts.agents : undefined;
  const index = await openIndex(ctx.store);
  if (opts.global && opts.project) throw new CliError(1, "--global cannot be combined with --project");
  const global = !opts.project;
  const project = global ? await loadProject(ctx.cwd) : await requireProject(ctx.cwd);

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
        if (hit.ids.length > 0 || globals.some((g) => g.name === sel)) notes.push(`${sel} is not in this project but in the global library; use -g`);
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
