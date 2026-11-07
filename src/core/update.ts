import { promises as fsp } from "node:fs";
import path from "node:path";
import { msgOf } from "../lib/cli.ts";
import { cleanup, cloneRepo, remoteTree, treeAt } from "../lib/git.ts";
import { hashSkillDir } from "../lib/hash.ts";
import { loadProject, mutateManifest, type Project } from "../lib/manifest.ts";
import { requireStagedSkill } from "../lib/discover.ts";
import { isCommitSha } from "../lib/source.ts";
import {
  commitVersionDir,
  copySkill,
  exists,
  findRecord,
  findVersion,
  now,
  stagingDir,
  versionDir,
  versionKeyFor,
} from "../lib/store.ts";
import { ctxOf, mutateIndex, resolveSelectors, type BaseOptions } from "./context.ts";
import { openIndex } from "../lib/migrate.ts";

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
  if (opts.global && opts.project) return ["project", "global"];
  if (opts.global) return ["global"];
  if (opts.project) return ["project"];
  const hasProject = !!project && Object.keys(project.manifest.skills).length > 0;
  if (opts.skills && opts.skills.length > 0) return hasProject ? ["project", "global"] : ["global"];
  return hasProject ? ["project"] : ["global"];
}

async function targets(opts: UpdateOptions): Promise<{ list: Target[]; scopes: Array<"project" | "global">; project: Project | null; store: string }> {
  const ctx = ctxOf(opts);
  const index = await openIndex(ctx.store);
  const project = await loadProject(ctx.cwd);
  const scopes = resolveScopes(opts, project);
  const list: Target[] = [];
  if (scopes.includes("project") && project) {
    for (const [id, e] of Object.entries(project.manifest.skills)) {
      if (id.startsWith("local://")) continue;
      const record = findRecord(index, id);
      const key = record ? findVersion(record, { ...(e.commit ? { commit: e.commit } : {}), ...(e.hash ? { hash: e.hash } : {}) }) : undefined;
      const v = record && key ? record.versions[key] : undefined;
      list.push({
        id,
        name: v?.name ?? id.split("/").pop() ?? id,
        scope: "project",
        url: e.source ?? "",
        ref: e.ref ?? null,
        sub: e.path ?? "",
        commit: e.commit ?? null,
        tree: v?.tree ?? null,
        local: e.commit === undefined,
      });
    }
  }
  if (scopes.includes("global")) {
    for (const r of index.skills) {
      if (!r.global) continue;
      const v = r.versions[r.current];
      list.push({
        id: r.id,
        name: v?.name ?? r.id,
        scope: "global",
        url: r.source.url,
        ref: r.source.ref,
        sub: r.source.path,
        commit: v?.commit ?? null,
        tree: v?.tree ?? null,
        local: r.source.type !== "git",
      });
    }
  }
  let filtered = list;
  if (opts.skills && opts.skills.length > 0) {
    const { ids } = await resolveSelectors(list, opts.skills, opts.chooseAmbiguous);
    filtered = list.filter((t) => ids.includes(t.id));
  }
  return { list: filtered, scopes, project, store: ctx.store };
}

async function probe(t: Target): Promise<{ status: UpdateStatus; reason?: string; commit?: string }> {
  if (t.local) return { status: "skipped", reason: "Local path" };
  if (t.ref && isCommitSha(t.ref)) return { status: "skipped", reason: "Pinned to a commit" };
  const remote = await remoteTree(t.url, t.ref, t.sub);
  if (remote.tree === null) return { status: "skipped", reason: "removed upstream" };
  if (t.tree !== null && remote.tree === t.tree) return { status: "up-to-date" };
  if (t.tree === null && remote.commit === t.commit) return { status: "up-to-date" };
  return { status: "has-update", commit: remote.commit };
}

/** `check`: report available updates; writes nothing. */
export async function checkSkills(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const { list, scopes } = await targets(opts);
  const rows: UpdateRow[] = [];
  for (const t of list) {
    try {
      const p = await probe(t);
      rows.push({ id: t.id, name: t.name, scope: t.scope, status: p.status, ...(p.reason ? { reason: p.reason } : {}) });
    } catch (err) {
      rows.push({ id: t.id, name: t.name, scope: t.scope, status: "failed", reason: msgOf(err) });
    }
  }
  return { skills: rows, scopes };
}

/** `update`: pull the newest content from each skill's source and move the pin (project) or `current` (-g). */
export async function updateSkills(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const { list, scopes, project, store } = await targets(opts);
  const rows: UpdateRow[] = [];
  for (const t of list) {
    const base = { id: t.id, name: t.name, scope: t.scope };
    let staged: string | null = null;
    let checkout: string | null = null;
    try {
      const p = await probe(t);
      if (p.status !== "has-update") {
        rows.push({ ...base, status: p.status, ...(p.reason ? { reason: p.reason } : {}) });
        continue;
      }
      const cloned = await cloneRepo(t.url, t.ref ?? undefined);
      checkout = cloned.dir;
      const src = path.join(cloned.dir, t.sub);
      if (!(await exists(path.join(src, "SKILL.md")))) {
        rows.push({ ...base, status: "skipped", reason: "removed upstream" });
        continue;
      }
      staged = await stagingDir(store);
      await copySkill(src, staged, "folder");
      const hash = await hashSkillDir(staged);
      const tree = await treeAt(cloned.dir, t.sub);
      const meta = await requireStagedSkill(staged, `${t.id} at ${cloned.commit.slice(0, 12)}`);
      const commit = cloned.commit;
      const stagedDir = staged;
      await mutateIndex(store, async (index) => {
        const record = findRecord(index, t.id);
        if (!record) throw new Error(`${t.id} is not in the library`);
        const info = { commit, hash };
        const key = findVersion(record, info) ?? versionKeyFor(record, info);
        const dest = versionDir(store, record, key);
        await commitVersionDir(stagedDir, dest);
        record.versions[key] ??= {
          commit,
          ...(tree ? { tree } : {}),
          hash,
          name: meta.name,
          description: meta.description,
          addedAt: now(),
        };
        record.updatedAt = now();
        if (t.scope === "global") record.current = key;
      });
      staged = null;
      if (t.scope === "project" && project) {
        // Re-read under the manifest lock; only move a pin that is still the one we checked.
        await mutateManifest(project, (manifest) => {
          const e = manifest.skills[t.id];
          if (e && e.commit === t.commit) {
            e.commit = commit;
            e.hash = hash;
            e.name = meta.name;
          }
        });
      }
      rows.push({ ...base, status: "updated", ...(t.commit ? { from: t.commit.slice(0, 7) } : {}), to: commit.slice(0, 7) });
    } catch (err) {
      rows.push({ ...base, status: "failed", reason: msgOf(err) });
    } finally {
      if (staged) await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
      await cleanup(checkout);
    }
  }
  return { skills: rows, scopes };
}
