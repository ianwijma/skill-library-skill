import { promises as fsp } from "node:fs";
import path from "node:path";
import { msgOf } from "../lib/cli.ts";
import { cleanup, cloneRepo, remoteTree, treeAt } from "../lib/git.ts";
import { hashSkillDir } from "../lib/hash.ts";
import { loadProject, mutateManifest, type Project } from "../lib/manifest.ts";
import { requireStagedSkill } from "../lib/discover.ts";
import { isCommitSha } from "../lib/source.ts";
import {
  placeVersion,
  copySkill,
  exists,
  findRecord,
  findVersion,
  now,
  stagingDir,
  versionDir,
  versionKeyFor,
  openIndex,
} from "../lib/store.ts";
import { ctxOf, mutateIndex, resolveSelectors, type BaseOptions } from "./context.ts";

export interface UpdateOptions extends BaseOptions {
  /** Skill names or ids; empty = all in scope. */
  skills?: string[];
  global?: boolean;
  project?: boolean;
  /** CLI hook: pick one id when a name matches several skills (return null to skip it). */
  chooseAmbiguous?: (selector: string, ids: string[]) => Promise<string | null>;
}

export type UpdateStatus = "updated" | "up-to-date" | "has-update" | "skipped" | "failed";

export interface UpdateRow {
  id: string;
  name: string;
  scope: "project" | "global";
  status: UpdateStatus;
  reason?: string;
  from?: string;
  to?: string;
}

export interface UpdateResult {
  skills: UpdateRow[];
  scopes: Array<"project" | "global">;
}

interface Target {
  id: string;
  name: string;
  scope: "project" | "global";
  url: string;
  ref: string | null;
  sub: string;
  commit: string | null;
  tree: string | null;
  local: boolean;
}

/** vercel's scope rules: flags win; named skills → both; else project if it has entries, else global. */
export function resolveScopes(opts: UpdateOptions, project: Project | null): Array<"project" | "global"> {
  if (opts.global && opts.project) {
    return ["project", "global"];
  }

  if (opts.global) {
    return ["global"];
  }

  if (opts.project) {
    return ["project"];
  }

  const hasProject = !!project && Object.keys(project.manifest.skills).length > 0;

  if (opts.skills && opts.skills.length > 0) {
    return hasProject ? ["project", "global"] : ["global"];
  }

  return hasProject ? ["project"] : ["global"];
}

async function targets(opts: UpdateOptions): Promise<{ list: Target[]; scopes: Array<"project" | "global">; project: Project | null; store: string }> {
  const ctx = ctxOf(opts);
  const index = await openIndex(ctx.store);
  const project = await loadProject(ctx.cwd);
  const scopes = resolveScopes(opts, project);
  const list: Target[] = [];

  if (scopes.includes("project") && project) {
    for (const [id, entry] of Object.entries(project.manifest.skills)) {
      if (id.startsWith("local://")) {
        continue;
      }

      const record = findRecord(index, id);
      const key = record
        ? findVersion(record, {
            ...(entry.commit ? { commit: entry.commit } : {}),
            ...(entry.hash ? { hash: entry.hash } : {}),
          })
        : undefined;
      const version = record && key ? record.versions[key] : undefined;

      list.push({
        id,
        name: version?.name ?? id.split("/").pop() ?? id,
        scope: "project",
        url: entry.source ?? "",
        ref: entry.ref ?? null,
        sub: entry.path ?? "",
        commit: entry.commit ?? null,
        tree: version?.tree ?? null,
        local: entry.commit === undefined,
      });
    }
  }

  if (scopes.includes("global")) {
    for (const record of index.skills) {
      if (!record.global) {
        continue;
      }

      const version = record.versions[record.current];

      list.push({
        id: record.id,
        name: version?.name ?? record.id,
        scope: "global",
        url: record.source.url,
        ref: record.source.ref,
        sub: record.source.path,
        commit: version?.commit ?? null,
        tree: version?.tree ?? null,
        local: record.source.type !== "git",
      });
    }
  }

  let filtered = list;

  if (opts.skills && opts.skills.length > 0) {
    const { ids } = await resolveSelectors(list, opts.skills, opts.chooseAmbiguous);

    filtered = list.filter((target) => ids.includes(target.id));
  }

  return { list: filtered, scopes, project, store: ctx.store };
}

async function probe(target: Target): Promise<{ status: UpdateStatus; reason?: string; commit?: string }> {
  if (target.local) {
    return { status: "skipped", reason: "Local path" };
  }

  if (target.ref && isCommitSha(target.ref)) {
    return { status: "skipped", reason: "Pinned to a commit" };
  }

  const remote = await remoteTree(target.url, target.ref, target.sub);

  if (remote.tree === null) {
    return { status: "skipped", reason: "removed upstream" };
  }

  if (target.tree !== null && remote.tree === target.tree) {
    return { status: "up-to-date" };
  }

  if (target.tree === null && remote.commit === target.commit) {
    return { status: "up-to-date" };
  }

  return { status: "has-update", commit: remote.commit };
}

/** `check`: report available updates; writes nothing. */
export async function checkSkills(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const { list, scopes } = await targets(opts);
  const rows: UpdateRow[] = [];

  for (const target of list) {
    try {
      const probed = await probe(target);

      rows.push({
        id: target.id,
        name: target.name,
        scope: target.scope,
        status: probed.status,
        ...(probed.reason ? { reason: probed.reason } : {}),
      });
    } catch (err) {
      rows.push({ id: target.id, name: target.name, scope: target.scope, status: "failed", reason: msgOf(err) });
    }
  }

  return { skills: rows, scopes };
}

/** `update`: pull the newest content from each skill's source and move the pin (project) or `current` (-g). */
export async function updateSkills(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const { list, scopes, project, store } = await targets(opts);
  const rows: UpdateRow[] = [];

  for (const target of list) {
    const base = { id: target.id, name: target.name, scope: target.scope };
    let staged: string | null = null;
    let checkout: string | null = null;

    try {
      const probed = await probe(target);

      if (probed.status !== "has-update") {
        rows.push({ ...base, status: probed.status, ...(probed.reason ? { reason: probed.reason } : {}) });
        continue;
      }

      const cloned = await cloneRepo(target.url, target.ref ?? undefined);

      checkout = cloned.dir;
      const src = path.join(cloned.dir, target.sub);

      if (!(await exists(path.join(src, "SKILL.md")))) {
        rows.push({ ...base, status: "skipped", reason: "removed upstream" });
        continue;
      }

      staged = await stagingDir(store);
      await copySkill(src, staged, "folder");
      const hash = await hashSkillDir(staged);
      const tree = await treeAt(cloned.dir, target.sub);
      const meta = await requireStagedSkill(staged, `${target.id} at ${cloned.commit.slice(0, 12)}`);
      const commit = cloned.commit;
      const stagedDir = staged;

      await mutateIndex(store, async (index) => {
        const record = findRecord(index, target.id);

        if (!record) {
          throw new Error(`${target.id} is not in the library`);
        }

        const info = { commit, hash };
        const key = findVersion(record, info) ?? versionKeyFor(record, info);
        const dest = versionDir(store, record, key);

        await placeVersion(stagedDir, dest, hash);
        record.versions[key] ??= {
          commit,
          ...(tree ? { tree } : {}),
          hash,
          name: meta.name,
          description: meta.description,
          addedAt: now(),
        };
        record.updatedAt = now();

        if (target.scope === "global") {
          record.current = key;
        }
      });
      staged = null;

      if (target.scope === "project" && project) {
        // Re-read under the manifest lock; only move a pin that is still the one we checked.
        await mutateManifest(project, (manifest) => {
          const entry = manifest.skills[target.id];

          if (entry?.commit === target.commit) {
            entry.commit = commit;
            entry.hash = hash;
            entry.name = meta.name;
          }
        });
      }

      rows.push({ ...base, status: "updated", ...(target.commit ? { from: target.commit.slice(0, 7) } : {}), to: commit.slice(0, 7) });
    } catch (err) {
      rows.push({ ...base, status: "failed", reason: msgOf(err) });
    } finally {
      if (staged) {
        await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
      }

      await cleanup(checkout);
    }
  }

  return { skills: rows, scopes };
}
