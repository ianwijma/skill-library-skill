import { promises as fsp } from "node:fs";
import path from "node:path";
import { CliError, msgOf } from "../lib/cli.ts";
import { discoverSkills, filterSkills, parseSkillFile, requireStagedSkill, type DiscoveredSkill } from "../lib/discover.ts";
import { cleanup, cloneRepo, treeAt } from "../lib/git.ts";
import { hashSkillDir } from "../lib/hash.ts";
import { gitSkillId, isReservedSkillName, localSkillId, skillDirFor } from "../lib/ids.ts";
import { loadProject, mutateManifest, type ManifestEntry, type Project } from "../lib/manifest.ts";
import { tildify, toPosix } from "../lib/paths.ts";
import { parseSource, type ParsedSource } from "../lib/source.ts";
import {
  placeVersion,
  copySkill,
  openIndex,
  findRecord,
  now,
  stagingDir,
  versionDir,
  versionKeyFor,
  type AgentsValue,
  type SourceInfo,
  type StoreIndex,
} from "../lib/store.ts";
import { agentsArg, ctxOf, mergeAgents, mutateIndex, type BaseOptions } from "./context.ts";

export interface AddOptions extends BaseOptions {
  /**
   * Pin the skills into the project's skill-library.json (created in `cwd` when there is none)
   * instead of the global library, which is the default.
   */
  project?: boolean;
  /** Add to the global library (the default; kept so `-g` stays explicit). Cannot be combined with `project`. */
  global?: boolean;
  /** Agents the skill is for (default: all; `['*']` = all). */
  agents?: string[];
  /** Skill names or ids to add; `['*']` = all. Default: every discovered skill (API) or a prompt (CLI). */
  skills?: string[];
  fullDepth?: boolean;
  /** Only discover; write nothing. */
  list?: boolean;
  /** CLI hook: choose skills when several were found and none were named. */
  selectSkills?: (skills: DiscoveredSkill[]) => Promise<DiscoveredSkill[]>;
  /** CLI hook: confirm before anything is written. Return false to cancel. */
  confirm?: (skills: DiscoveredSkill[], scope: "project" | "global", kind?: "skills" | "gateway") => Promise<boolean>;
  /**
   * Global scope: called when a skill being added has the same name as other global skills.
   * Return the ids to replace — they stop being global (their files stay in the store, listed as
   * not global). Without this hook nothing is replaced.
   */
  resolveClashes?: (clashes: NameClash[]) => Promise<string[]>;
}

/** A skill being added globally whose name is already used by other global skills. */
export interface NameClash {
  name: string;
  /** Id of the skill being added. */
  id: string;
  existing: Array<{
    id: string;
    /** Git URL or folder path it came from. */
    source: string;
    sourceType: "git" | "local";
    /** Same files as the skill being added. */
    sameContent: boolean;
  }>;
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
  discovered: Array<{ id: string; name: string; description: string; path: string }>;
  skills: AddedSkill[];
  /** The source held only the skill-library gateway (nothing is stored). */
  gatewayOnly: boolean;
  /** The confirm hook declined. */
  cancelled: boolean;
  /** Global skills replaced by a skill of the same name (no longer global). */
  replaced: Array<{ id: string; name: string }>;
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

  if (opts.global && opts.project) {
    throw new CliError(1, "--global cannot be combined with --project");
  }

  let project: Project | null = null;
  const scope: "project" | "global" = opts.project ? "project" : "global";

  if (scope === "project") {
    project = await loadProject(ctx.cwd);

    if (!project) {
      throw new CliError(1, "No project here: skill-library.json is not created in your home directory.", "Run it in a project folder, or drop -p to add to the global library.");
    }
  }

  const projectRoot = scope === "project" ? project!.root : null;

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
      const fileSkill = await parseSkillFile(base, "file");

      found = fileSkill && !isReservedSkillName(fileSkill.name) ? [fileSkill] : [];

      if (fileSkill && isReservedSkillName(fileSkill.name)) {
        reserved = [fileSkill];
      }
    } else {
      const discovery = await discoverSkills(base, parsed.subpath, { ...(opts.fullDepth ? { fullDepth: true } : {}) });

      found = discovery.skills;
      reserved = discovery.reserved;
    }

    const idOf = (skill: DiscoveredSkill): string => (parsed.type === "git" ? gitSkillId(parsed.url, skill.name) : localSkillId(skill.path, projectRoot));
    const discovered = found.map((skill) => ({
      id: idOf(skill),
      name: skill.name,
      description: skill.description,
      path: skill.path,
    }));
    const result: AddResult = {
      source: parsed,
      scope,
      projectRoot,
      discovered,
      skills: [],
      gatewayOnly: false,
      cancelled: false,
      replaced: [],
    };

    if (found.length === 0) {
      if (reserved.length > 0) {
        result.gatewayOnly = true;

        // Placing the gateway writes agent folders, so it needs the same confirmation as a store write.
        if (!opts.list && opts.confirm && !(await opts.confirm(reserved, scope, "gateway"))) {
          result.cancelled = true;
        }

        return result;
      }

      throw new CliError(1, "No valid skills found. Skills require a SKILL.md with name and description.");
    }

    if (opts.list) {
      return result;
    }

    const selectors = [...(opts.skills ?? []), ...(parsed.skillFilter ? [parsed.skillFilter] : [])];
    let selected: DiscoveredSkill[];

    if (selectors.includes("*")) {
      selected = found;
    } else if (selectors.length > 0) {
      const byId = found.filter((skill) => selectors.includes(idOf(skill)));
      const byName = filterSkills(found, selectors.filter((sel) => !found.some((skill) => idOf(skill) === sel)));

      selected = found.filter((skill) => byId.includes(skill) || byName.includes(skill));

      if (selected.length === 0) {
        throw new CliError(1, `No matching skills found for: ${selectors.join(", ")}`, `Available skills:\n${found.map((skill) => `  - ${skill.name}`).join("\n")}`);
      }
    } else if (found.length === 1 || !opts.selectSkills) {
      selected = found;
    } else {
      selected = await opts.selectSkills(found);
    }

    if (selected.length === 0) {
      result.cancelled = true;

      return result;
    }

    if (opts.confirm && !(await opts.confirm(selected, scope))) {
      result.cancelled = true;

      return result;
    }

    const prepared: Prepared[] = [];

    try {
      for (const skill of selected) {
        prepared.push(await prepare(ctx.store, parsed, skill, base, commit, projectRoot));
      }

      const retire = new Map<string, string[]>();

      if (scope === "global" && opts.resolveClashes) {
        const clashes = nameClashes(await openIndex(ctx.store), prepared);

        if (clashes.length > 0) {
          const chosen = new Set(await opts.resolveClashes(clashes));

          for (const clash of clashes) {
            const ids = clash.existing.map((entry) => entry.id).filter((id) => chosen.has(id));

            if (ids.length > 0) {
              retire.set(clash.id, ids);
            }
          }
        }
      }

      result.skills = await commitAll(ctx.store, prepared, scope, project, requested, retire, result.replaced);
    } finally {
      for (const item of prepared) {
        if (item.staged) {
          await fsp.rm(item.staged, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

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
    const staged = await stagingDir(store);

    await copySkill(skill.path, staged, "folder");
    await assertStagedSkill(staged, skill);

    return {
      skill,
      id: gitSkillId(parsed.url, skill.name),
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
  await assertStagedSkill(staged, skill);

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

/** The copier skips symlinks; a skill whose SKILL.md is a link must not be stored without it. */
async function assertStagedSkill(staged: string, skill: DiscoveredSkill): Promise<void> {
  try {
    await requireStagedSkill(staged, skill.path, { name: skill.name, description: skill.description });
  } catch (err) {
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Global skills that share a name with a skill about to be stored globally (other ids only). */
function nameClashes(index: StoreIndex, prepared: Prepared[]): NameClash[] {
  const out: NameClash[] = [];

  for (const item of prepared) {
    if (item.local) {
      continue;
    }

    const existing: NameClash["existing"] = [];

    for (const record of index.skills) {
      const version = record.versions[record.current];

      if (!record.global || record.id === item.id || version?.name !== item.skill.name) {
        continue;
      }

      existing.push({ id: record.id, source: record.source.url, sourceType: record.source.type === "git" ? "git" : "local", sameContent: version.hash === item.hash });
    }

    if (existing.length > 0) {
      out.push({ name: item.skill.name, id: item.id, existing });
    }
  }

  return out;
}

async function commitAll(
  store: string,
  prepared: Prepared[],
  scope: "project" | "global",
  project: Project | null,
  requested: AgentsValue,
  retire = new Map<string, string[]>(),
  replaced: AddResult["replaced"] = [],
): Promise<AddedSkill[]> {
  const rows: AddedSkill[] = [];
  const stored = prepared.filter((item) => !item.local);

  if (stored.length > 0) {
    await mutateIndex(store, async (index) => {
      for (const item of stored) {
        let row: AddedSkill;

        try {
          row = await commitOne(store, index, item, scope, requested);
        } catch (err) {
          row = failedRow(item, scope, requested, err);
        }

        rows.push(row);

        if (row.status !== "installed") {
          continue;
        }

        // Replace only once the new skill is in: the old one stays in the store, just not global.
        for (const id of retire.get(item.id) ?? []) {
          const old = findRecord(index, id);

          if (!old?.global) {
            continue;
          }

          old.global = false;
          old.updatedAt = now();
          replaced.push({ id, name: item.skill.name });
        }
      }
    });
  }

  for (const item of prepared.filter((candidate) => candidate.local)) {
    rows.push({ id: item.id, name: item.skill.name, status: "installed", scope: "project", source: item.id, ref: null, hash: null, commit: null, path: item.skill.path, agents: requested });
  }

  if (scope === "project" && project) {
    const done = rows.filter((row) => row.status === "installed");

    if (done.length > 0) {
      await mutateManifest(project, (manifest) => {
        for (const row of done) {
          const item = prepared.find((candidate) => candidate.id === row.id)!;
          const agents = mergeAgents(manifest.skills[row.id]?.agents, requested);

          row.agents = agents;
          let entry: ManifestEntry;

          if (item.local) {
            entry = { name: item.skill.name, agents };
          } else if (item.sourceInfo.type === "git") {
            entry = {
              name: item.skill.name,
              source: item.sourceInfo.url,
              ref: item.sourceInfo.ref,
              path: item.relPath,
              commit: item.commit!,
              hash: item.hash!,
              agents,
            };
          } else {
            entry = { name: item.skill.name, source: tildify(item.sourceInfo.url), hash: item.hash!, agents };
          }

          manifest.skills[row.id] = entry;
        }
      });
    }
  }

  return rows;
}

function failedRow(item: Prepared, scope: "project" | "global", agents: AgentsValue, err: unknown): AddedSkill {
  return { id: item.id, name: item.skill.name, status: "failed", scope, source: item.sourceInfo.url, ref: item.sourceInfo.ref, hash: item.hash, commit: item.commit, path: null, agents, error: msgOf(err) };
}

async function commitOne(store: string, index: StoreIndex, item: Prepared, scope: "project" | "global", requested: AgentsValue): Promise<AddedSkill> {
  const at = now();
  let record = findRecord(index, item.id);
  const versionInfo = { ...(item.commit ? { commit: item.commit } : {}), hash: item.hash! };
  const isNew = !record;

  if (!record) {
    record = { id: item.id, source: item.sourceInfo, dir: skillDirFor(item.id, item.skill.name), versions: {}, current: "", global: false, agents: "all", addedAt: at, updatedAt: at };
    index.skills.push(record);
  }

  const key = versionKeyFor(record, versionInfo);
  const dest = versionDir(store, record, key);

  await placeVersion(item.staged!, dest, item.hash!);
  item.staged = null;
  record.versions[key] ??= {
    ...(item.commit ? { commit: item.commit } : {}),
    ...(item.tree ? { tree: item.tree } : {}),
    hash: item.hash!,
    name: item.skill.name,
    description: item.skill.description,
    addedAt: at,
  };
  record.updatedAt = at;

  let agents: AgentsValue = requested;

  if (scope === "global") {
    record.current = key;
    record.source = item.sourceInfo;
    agents = record.global ? mergeAgents(record.agents, requested) : requested;
    record.global = true;
    record.agents = agents;
  } else if (isNew) {
    record.current = key;
  }

  return { id: item.id, name: item.skill.name, status: "installed", scope, source: item.sourceInfo.url, ref: item.sourceInfo.ref, hash: item.hash, commit: item.commit, path: dest, agents };
}
