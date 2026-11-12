import { loadProject } from "../lib/manifest.ts";
import { openIndex } from "../lib/store.ts";
import { agentsArg, agentsMatch, ctxOf, projectSkills, storeSkills, type BaseOptions, type ScopedSkill } from "./context.ts";

export interface ListOptions extends BaseOptions {
  /** List the store (all skills; non-global ones are `untracked`) instead of the project. */
  global?: boolean;
  /** Only skills available to these agents. */
  agents?: string[];
}

export interface ListResult {
  scope: "project" | "global";
  projectRoot: string | null;
  skills: ScopedSkill[];
}

export async function listSkills(opts: ListOptions = {}): Promise<ListResult> {
  const ctx = ctxOf(opts);
  const filter = opts.agents && opts.agents.length > 0 ? agentsArg(opts.agents, false) : "all";
  const index = await openIndex(ctx.store);
  const found = opts.global ? null : await loadProject(ctx.cwd);
  // Without a skill-library.json there is no project: list the global library.
  const project = found?.exists ? found : null;
  const global = !project;
  const skills = global ? await storeSkills(ctx.store, index, true) : await projectSkills(ctx.store, index, project!);
  const matches = filter === "all" ? skills : skills.filter((s) => filter.some((a) => agentsMatch(s.agents, a)));
  matches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  return { scope: global ? "global" : "project", projectRoot: project?.root ?? null, skills: matches };
}
