import path from "node:path";
import { openIndex } from "../lib/store.ts";
import type { NoulResponse } from "@typesafe-ai/sdk";
import { CliError, warn } from "../lib/cli.ts";
import { loadProject } from "../lib/manifest.ts";
import { buildRequest, callSystemOne } from "../lib/typesafe.ts";
import { agentsArg, agentsMatch, ctxOf, projectSkills, storeSkills, type BaseOptions, type ScopedSkill } from "./context.ts";

export interface QueryOptions extends BaseOptions {
  /** Calling agent id; filters out skills meant only for other agents. */
  agent?: string;
  threshold?: number;
  top?: number;
  /** TypeSafe API key (default: $SKILL_LIBRARY_TYPESAFE_API_KEY). */
  apiKey?: string;
}

export interface QueryMatch {
  id: string;
  name: string;
  description: string;
  /** Absolute path of the SKILL.md to read. */
  path: string;
  probability: number;
  scope: "project" | "global";
}

export interface QueryResult {
  matches: QueryMatch[];
  /** Project skills referenced but not installed (run `skill-library install`). */
  notInstalled: number;
  usage?: unknown;
  model?: string;
}

const PRIORITY: Record<string, number> = { local: 0, referenced: 1, global: 2 };

function priorityOf(s: ScopedSkill): number {
  if (s.scope === "global") return PRIORITY.global!;
  return s.kind === "local" ? PRIORITY.local! : PRIORITY.referenced!;
}

/**
 * Candidate selection (plan §5.1): collect, shadow by name (the higher-priority skill wins even
 * when it is later unavailable or filtered out), drop unavailable, filter by agent, skip empty
 * descriptions.
 */
export function selectCandidates(all: ScopedSkill[], agent: string | undefined): { candidates: ScopedSkill[]; notInstalled: number } {
  const best = new Map<string, number>();
  for (const s of all) {
    const p = priorityOf(s);
    const cur = best.get(s.name);
    if (cur === undefined || p < cur) best.set(s.name, p);
  }
  const unshadowed = all.filter((s) => priorityOf(s) === best.get(s.name));
  const notInstalled = unshadowed.filter((s) => s.scope === "project" && s.status === "missing").length;
  const candidates: ScopedSkill[] = [];
  for (const s of unshadowed) {
    if (s.status !== "installed" || s.dir === null) continue;
    if (!agentsMatch(s.agents, agent)) continue;
    if (s.description.trim() === "") {
      warn(`skill '${s.name}' (${s.id}) has an empty description; excluded from query`);
      continue;
    }
    candidates.push(s);
  }
  return { candidates, notInstalled };
}

export async function gatherCandidates(opts: QueryOptions = {}): Promise<{ candidates: ScopedSkill[]; notInstalled: number }> {
  const ctx = ctxOf(opts);
  if (opts.agent !== undefined) agentsArg([opts.agent], false);
  const index = await openIndex(ctx.store);
  const project = await loadProject(ctx.cwd);
  const all = [...(project ? await projectSkills(ctx.store, index, project) : []), ...(await storeSkills(ctx.store, index, false))];
  return selectCandidates(all, opts.agent);
}

export async function querySkills(task: string, opts: QueryOptions = {}): Promise<QueryResult> {
  const trimmed = task.trim();
  if (trimmed === "") throw new CliError(1, "task text is empty");
  const threshold = opts.threshold ?? 0.7;
  const { candidates, notInstalled } = await gatherCandidates(opts);
  if (candidates.length === 0) return { matches: [], notInstalled };

  const apiKey = opts.apiKey ?? process.env.SKILL_LIBRARY_TYPESAFE_API_KEY;
  if (!apiKey) throw new CliError(2, "SKILL_LIBRARY_TYPESAFE_API_KEY is not set (required for query). Export it and retry.");

  // Opaque keys: ids (which may contain local paths) never leave the machine.
  const keyed = candidates.map((s, i) => ({ key: `s${i}`, skill: s }));
  const request = buildRequest(
    trimmed,
    keyed.map(({ key, skill }) => ({ id: key, name: skill.name, description: skill.description })),
  );
  const response = await callSystemOne(request, apiKey);
  const byKey = new Map(keyed.map(({ key, skill }) => [key, skill]));
  const answers = response.answers as Record<string, NoulResponse>;
  const matches: QueryMatch[] = [];
  for (const [key, answer] of Object.entries(answers)) {
    const s = byKey.get(key);
    const probability = answer && typeof answer.noul === "number" ? answer.noul : undefined;
    if (!s || probability === undefined || probability < threshold) continue;
    matches.push({ id: s.id, name: s.name, description: s.description, path: path.join(s.dir!, "SKILL.md"), probability, scope: s.scope });
  }
  matches.sort((a, b) => b.probability - a.probability || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    matches: opts.top !== undefined ? matches.slice(0, opts.top) : matches,
    notInstalled,
    usage: response.usage,
    model: response.model,
  };
}
