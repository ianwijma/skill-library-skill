import { promises as fsp } from "node:fs";
import path from "node:path";
import { CliError, msgOf, note } from "../lib/cli.ts";
import { discoverSkills, filterSkills, parseSkillFile, type DiscoveredSkill } from "../lib/discover.ts";
import { cleanup, cloneRepo, treeAt } from "../lib/git.ts";
import { hashSkillDir } from "../lib/hash.ts";
import { gitSkillId, localSkillId, skillDirFor } from "../lib/ids.ts";
import { loadProject, saveManifest, type ManifestEntry, type Project } from "../lib/manifest.ts";
import { tildify, toPosix } from "../lib/paths.ts";
import { parseSource, type ParsedSource } from "../lib/source.ts";
import {
  commitVersionDir,
  copySkill,
  exists,
  findRecord,
  now,
  stagingDir,
  versionDir,
  versionKeyFor,
  type AgentsValue,
  type SourceInfo,
  type StoreRecord,
} from "../lib/store.ts";
import { agentsArg, ctxOf, mergeAgents, mutateIndex, type BaseOptions } from "./context.ts";

export interface AddOptions extends BaseOptions {
  /** Add to the global scope instead of the current project. */
  global?: boolean;
  /** Agents the skill is for (default: all; `['*']` = all). */
  agents?: string[];
  /** Skill names to add; `['*']` = all. Default: every discovered skill (API) or a prompt (CLI). */
  skills?: string[];
  fullDepth?: boolean;
  /** Only discover; write nothing. */
  list?: boolean;
  /** CLI hook: choose skills when several were found and none were named. */
  selectSkills?: (skills: DiscoveredSkill[]) => Promise<DiscoveredSkill[]>;
}

export interface AddedSkill {
  id: string;
  name: string;
  status: "installed" | "skipped" | "failed";
  scope: "project" | "global";
  source: string;
  ref: string | null;
  hash: string | null;
  commit: string | null;
  /** Version folder (or the in-place folder for local:// skills). */
  path: string | null;
  agents: AgentsValue;
  error?: string;
}

export interface AddResult {
  source: ParsedSource;
  scope: "project" | "global";
  projectRoot: string | null;
  /** Discovered skills (set for list mode and always informative). */
  discovered: Array<{ name: string; description: string; path: string }>;
  skills: AddedSkill[];
  /** The source held only the skill-library gateway (nothing is stored). */
  gatewayOnly: boolean;
}

interface Prepared {
  skill: DiscoveredSkill;
  id: string;
  staged: string | null;
  hash: string | null;
  commit: string | null;
  tree: string | null;
  relPath: string;
  sourceInfo: SourceInfo;
  local: boolean;
}

export async function addSkills(source: string, opts: AddOptions = {}): Promise<AddResult> {
  const ctx = ctxOf(opts);
  const parsed = parseSource(source, ctx.cwd);
  const requested = agentsArg(opts.agents);

  let project: Project | null = null;
  let scope: "project" | "global" = opts.global ? "global" : "project";
  if (scope === "project") {
    project = await loadProject(ctx.cwd);
    if (!project) {
      scope = "global";
      if (!opts.list) note("No project here; using global scope.");
    }
  }

  let cloneDir: string | null = null;
  let commit: string | null = null;
  let base: string;
  let fileSource = false;
  try {
    if (parsed.type === "git") {
      const cloned = await cloneRepo(parsed.url, parsed.ref);
      cloneDir = cloned.dir;
      commit = cloned.commit;
      base = cloned.dir;
    } else {
      base = parsed.url;
      let st;
      try {
        st = await fsp.stat(base);
      } catch {
        throw new CliError(1, `Local path does not exist: ${base}`);
      }
      fileSource = st.isFile();
    }

    let found: DiscoveredSkill[];
    let reserved: DiscoveredSkill[] = [];
    if (fileSource) {
      const s = await parseSkillFile(base, "file");
      found = s ? [s] : [];
    } else {
      const d = await discoverSkills(base, parsed.subpath, { ...(opts.fullDepth ? { fullDepth: true } : {}) });
      found = d.skills;
      reserved = d.reserved;
    }
    const discovered = found.map((s) => ({ name: s.name, description: s.description, path: s.path }));
    const result: AddResult = { source: parsed, scope, projectRoot: project?.root ?? null, discovered, skills: [], gatewayOnly: false };

    if (found.length === 0) {
      if (reserved.length > 0) {
        result.gatewayOnly = true;
        return result;
      }
      throw new CliError(1, "No valid skills found. Skills require a SKILL.md with name and description.");
    }
    if (opts.list) return result;

    const selectors = [...(opts.skills ?? []), ...(parsed.skillFilter ? [parsed.skillFilter] : [])];
    let selected: DiscoveredSkill[];
    if (selectors.includes("*")) selected = found;
    else if (selectors.length > 0) {
      selected = filterSkills(found, selectors);
      if (selected.length === 0) {
        throw new CliError(1, `No matching skills found for: ${selectors.join(", ")}`, `Available skills:\n${found.map((s) => `  - ${s.name}`).join("\n")}`);
      }
    } else if (found.length === 1 || !opts.selectSkills) selected = found;
    else selected = await opts.selectSkills(found);
    if (selected.length === 0) return result;

    const prepared: Prepared[] = [];
    try {
      for (const skill of selected) prepared.push(await prepare(ctx.store, parsed, skill, base, commit, scope === "project" ? project!.root : null));
      result.skills = await commit_(ctx.store, prepared, scope, project, requested, parsed);
    } finally {
      for (const p of prepared) if (p.staged) await fsp.rm(p.staged, { recursive: true, force: true }).catch(() => {});
    }
    if (project && scope === "project") await saveManifest(project);
    return result;
  } finally {
    await cleanup(cloneDir);
  }
}

async function prepare(
  store: string,
  parsed: ParsedSource,
  skill: DiscoveredSkill,
  base: string,
  commit: string | null,
  projectRoot: string | null,
): Promise<Prepared> {
  if (parsed.type === "git") {
    const relPath = toPosix(path.relative(base, skill.path));
    const id = gitSkillId(parsed.url, skill.name);
    const staged = await stagingDir(store);
    await copySkill(skill.path, staged, "folder");
    return {
      skill,
      id,
      staged,
      hash: await hashSkillDir(staged),
      commit,
      tree: await treeAt(base, relPath),
      relPath,
      sourceInfo: { type: "git", url: parsed.url, ref: parsed.ref ?? null, path: relPath },
      local: false,
    };
  }
  const id = localSkillId(skill.path, projectRoot);
  if (id.startsWith("local://")) {
    if (skill.kind === "file") {
      throw new CliError(1, `A single markdown file inside the project can't be read in place: ${skill.path}`, "Put it in its own folder as SKILL.md, or add it with -g.");
    }
    return { skill, id, staged: null, hash: null, commit: null, tree: null, relPath: "", sourceInfo: { type: "folder", url: skill.path, ref: null, path: "" }, local: true };
  }
  const staged = await stagingDir(store);
  await copySkill(skill.path, staged, skill.kind);
  return {
    skill,
    id,
    staged,
    hash: await hashSkillDir(staged),
    commit: null,
    tree: null,
    relPath: "",
    sourceInfo: { type: skill.kind, url: skill.path, ref: null, path: "" },
    local: false,
  };
}

async function commit_(
  store: string,
  prepared: Prepared[],
  scope: "project" | "global",
  project: Project | null,
  requested: AgentsValue,
  parsed: ParsedSource,
): Promise<AddedSkill[]> {
  const rows: AddedSkill[] = [];
  const stored = prepared.filter((p) => !p.local);
  if (stored.length > 0) {
    await mutateIndex(store, async (index) => {
      for (const p of stored) {
        try {
          rows.push(await commitOne(store, index, p, scope, project, requested));
        } catch (err) {
          rows.push(failedRow(p, scope, requested, err));
        }
      }
    });
  }
  for (const p of prepared.filter((x) => x.local)) {
    const entries = project!.manifest.skills;
    const agents = mergeAgents(entries[p.id]?.agents, requested);
    entries[p.id] = { agents };
    rows.push({
      id: p.id,
      name: p.skill.name,
      status: "installed",
      scope: "project",
      source: p.id,
      ref: null,
      hash: null,
      commit: null,
      path: p.skill.path,
      agents,
    });
  }
  void parsed;
  return rows;
}

function failedRow(p: Prepared, scope: "project" | "global", agents: AgentsValue, err: unknown): AddedSkill {
  return {
    id: p.id,
    name: p.skill.name,
    status: "failed",
    scope,
    source: p.sourceInfo.url,
    ref: p.sourceInfo.ref,
    hash: p.hash,
    commit: p.commit,
    path: null,
    agents,
    error: msgOf(err),
  };
}

async function commitOne(
  store: string,
  index: { skills: StoreRecord[] },
  p: Prepared,
  scope: "project" | "global",
  project: Project | null,
  requested: AgentsValue,
): Promise<AddedSkill> {
  const at = now();
  let record = findRecord(index as never, p.id);
  const versionInfo = { ...(p.commit ? { commit: p.commit } : {}), hash: p.hash! };
  const isNew = !record;
  if (!record) {
    record = {
      id: p.id,
      source: p.sourceInfo,
      dir: skillDirFor(p.id, p.skill.name),
      versions: {},
      current: "",
      global: false,
      agents: "all",
      addedAt: at,
      updatedAt: at,
    };
    index.skills.push(record);
  }
  const key = versionKeyFor(record, versionInfo);
  const dest = versionDir(store, record, key);
  if (!record.versions[key] || !(await exists(path.join(dest, "SKILL.md")))) {
    await commitVersionDir(p.staged!, dest);
    record.versions[key] = {
      ...(p.commit ? { commit: p.commit } : {}),
      ...(p.tree ? { tree: p.tree } : {}),
      hash: p.hash!,
      name: p.skill.name,
      description: p.skill.description,
      addedAt: at,
    };
  }
  p.staged = null;
  record.updatedAt = at;

  let agents: AgentsValue;
  if (scope === "global") {
    record.current = key;
    record.source = p.sourceInfo;
    agents = record.global ? mergeAgents(record.agents, requested) : requested;
    record.global = true;
    record.agents = agents;
  } else {
    if (isNew) record.current = key;
    const entries = project!.manifest.skills;
    agents = mergeAgents(entries[p.id]?.agents, requested);
    const entry: ManifestEntry =
      p.sourceInfo.type === "git"
        ? { source: p.sourceInfo.url, ref: p.sourceInfo.ref, path: p.relPath, commit: p.commit!, hash: p.hash!, agents }
        : { source: tildify(p.sourceInfo.url), hash: p.hash!, agents };
    entries[p.id] = entry;
  }
  return {
    id: p.id,
    name: p.skill.name,
    status: "installed",
    scope,
    source: p.sourceInfo.url,
    ref: p.sourceInfo.ref,
    hash: p.hash,
    commit: p.commit,
    path: dest,
    agents,
  };
}
