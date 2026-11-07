import { promises as fsp } from "node:fs";
import path from "node:path";
import { CliError, msgOf } from "../lib/cli.ts";
import { requireStagedSkill } from "../lib/discover.ts";
import { cleanup, fetchCommit, treeAt } from "../lib/git.ts";
import { hashSkillDir } from "../lib/hash.ts";
import { skillDirFor } from "../lib/ids.ts";
import { loadProject, type ManifestEntry } from "../lib/manifest.ts";
import { expandHome } from "../lib/paths.ts";
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
  type StoreIndex,
  openIndex,
} from "../lib/store.ts";
import { ctxOf, mutateIndex, type BaseOptions } from "./context.ts";

export interface InstallOptions extends BaseOptions {
  dryRun?: boolean;
  /** Re-hash present pinned versions and repair any whose content no longer matches. */
  force?: boolean;
  /** Fail when the manifest is empty (vercel's --frozen-lockfile; default in CI). */
  frozen?: boolean;
}

export type InstallStatus = "present" | "installed" | "repaired" | "refused" | "missing" | "local" | "would-install";

export interface InstallRow {
  id: string;
  status: InstallStatus;
  message?: string;
}

export interface InstallResult {
  projectRoot: string;
  skills: InstallRow[];
  ok: boolean;
}

interface Fetched {
  staged: string;
  hash: string;
  tree: string | null;
  name: string;
  description: string;
}

export async function installProject(opts: InstallOptions = {}): Promise<InstallResult> {
  const ctx = ctxOf(opts);
  const project = await loadProject(ctx.cwd);
  if (!project || !project.exists) {
    if (opts.frozen) throw new CliError(1, "No skill-library.json found (frozen lockfile).");
    return { projectRoot: project?.root ?? ctx.cwd, skills: [], ok: true };
  }
  const entries = Object.entries(project.manifest.skills);
  if (entries.length === 0 && opts.frozen) throw new CliError(1, "skill-library.json has no skills (frozen lockfile).");

  const rows: InstallRow[] = [];
  const work: Array<{ id: string; entry: ManifestEntry; repair: boolean }> = [];
  const index = await openIndex(ctx.store);

  for (const [id, entry] of entries) {
    if (id.startsWith("local://")) {
      rows.push({ id, status: "local" });
      continue;
    }
    const record = findRecord(index, id);
    const key = record ? findVersion(record, pinOf(entry)) : undefined;
    const dir = record && key ? versionDir(ctx.store, record, key) : null;
    const hasDir = dir !== null && (await exists(dir));
    const hasMd = dir !== null && (await exists(path.join(dir, "SKILL.md")));
    if (!hasDir) {
      work.push({ id, entry, repair: false });
      continue;
    }
    // An existing folder without SKILL.md is incomplete: always repair it.
    if (!hasMd) {
      work.push({ id, entry, repair: true });
      continue;
    }
    if (opts.force && (await hashSkillDir(dir!)) !== record!.versions[key!]!.hash) {
      work.push({ id, entry, repair: true });
      continue;
    }
    rows.push({ id, status: "present" });
  }

  if (opts.dryRun) {
    for (const w of work) rows.push({ id: w.id, status: "would-install" });
    return { projectRoot: project.root, skills: rows, ok: true };
  }

  const fetched = new Map<string, Fetched>();
  for (const w of work) {
    try {
      fetched.set(w.id, await fetchPinned(ctx.store, w.id, w.entry));
    } catch (err) {
      const refused = err instanceof PinMismatch;
      rows.push({ id: w.id, status: refused ? "refused" : "missing", message: msgOf(err) });
    }
  }

  if (fetched.size > 0) {
    await mutateIndex(ctx.store, async (idx) => {
      for (const w of work) {
        const f = fetched.get(w.id);
        if (!f) continue;
        try {
          rows.push({ id: w.id, status: await place(ctx.store, idx, w.id, w.entry, f, w.repair) });
        } catch (err) {
          rows.push({ id: w.id, status: "missing", message: msgOf(err) });
        }
      }
    });
  }
  for (const f of fetched.values()) await fsp.rm(f.staged, { recursive: true, force: true }).catch(() => {});
  const ok = rows.every((r) => r.status !== "refused" && r.status !== "missing");
  return { projectRoot: project.root, skills: rows, ok };
}

class PinMismatch extends CliError {
  constructor(message: string) {
    super(1, message);
  }
}

function pinOf(entry: ManifestEntry): { commit?: string; hash?: string } {
  return { ...(entry.commit !== undefined ? { commit: entry.commit } : {}), ...(entry.hash !== undefined ? { hash: entry.hash } : {}) };
}

async function fetchPinned(store: string, id: string, entry: ManifestEntry): Promise<Fetched> {
  const staged = await stagingDir(store);
  let checkout: string | null = null;
  try {
    let src: string;
    let kind: "folder" | "file" = "folder";
    let tree: string | null = null;
    if (entry.commit !== undefined) {
      if (!entry.source) throw new CliError(1, `${id} has no source in skill-library.json`);
      checkout = await fetchCommit(entry.source, entry.commit);
      src = path.join(checkout, entry.path ?? "");
      tree = await treeAt(checkout, entry.path ?? "");
      if (!(await exists(path.join(src, "SKILL.md")))) throw new CliError(2, `${id}: ${entry.path || "SKILL.md"} not found at ${entry.commit.slice(0, 12)}`);
    } else {
      if (!entry.source) throw new CliError(1, `${id} has no source in skill-library.json`);
      src = path.resolve(expandHome(entry.source));
      let st;
      try {
        st = await fsp.stat(src);
      } catch {
        throw new CliError(2, `${id}: folder not found: ${src}`);
      }
      kind = st.isFile() ? "file" : "folder";
    }
    await copySkill(src, staged, kind);
    const hash = await hashSkillDir(staged);
    if (entry.hash !== undefined && hash !== entry.hash) {
      const name = id.split("/").pop();
      throw new PinMismatch(
        entry.commit !== undefined
          ? `${id}: content hash does not match skill-library.json (expected ${entry.hash}, got ${hash}); refusing to install`
          : `${name} changed since it was pinned; run skill-library add ${entry.source} to re-pin`,
      );
    }
    const meta = await requireStagedSkill(staged, id, entry.name ? { name: entry.name, description: "" } : undefined);
    return { staged, hash, tree, name: meta.name, description: meta.description };
  } catch (err) {
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await cleanup(checkout);
  }
}

async function place(store: string, index: StoreIndex, id: string, entry: ManifestEntry, f: Fetched, repair: boolean): Promise<InstallStatus> {
  const at = now();
  let record = findRecord(index, id);
  if (!record) {
    record = {
      id,
      source:
        entry.commit !== undefined
          ? { type: "git", url: entry.source!, ref: entry.ref ?? null, path: entry.path ?? "" }
          : { type: "folder", url: path.resolve(expandHome(entry.source!)), ref: null, path: "" },
      dir: skillDirFor(id, f.name),
      versions: {},
      current: "",
      global: false,
      agents: "all",
      addedAt: at,
      updatedAt: at,
    };
    index.skills.push(record);
  }
  const info = { ...(entry.commit !== undefined ? { commit: entry.commit } : {}), hash: f.hash };
  const key = findVersion(record, info) ?? versionKeyFor(record, info);
  const dest = versionDir(store, record, key);
  // Re-check under the lock: an existing folder is kept only if intact, else replaced with rollback.
  await placeVersion(f.staged, dest, f.hash);
  record.versions[key] ??= {
    ...(entry.commit !== undefined ? { commit: entry.commit } : {}),
    ...(f.tree ? { tree: f.tree } : {}),
    hash: f.hash,
    name: f.name,
    description: f.description,
    addedAt: at,
  };
  if (record.current === "") record.current = key;
  record.updatedAt = at;
  return repair ? "repaired" : "installed";
}
