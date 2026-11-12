// Validators: check that what the CLI left on disk is consistent, independently of the CLI's own
// code (the content hash, the store layout and the manifest rules are re-implemented here from
// the docs). Each collects every problem and fails once, listing all of them.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { e2e, exists, readJson, type World } from "./harness.ts";

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256-[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SKIP = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);

// --- content hash (docs/03-data-store.md; must never drift) -------------------------------------

async function files(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await files(root, p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** sha256 over (u64be len(path) ‖ path ‖ u64be len(content) ‖ content) per file, paths byte-sorted. */
export async function contentHash(dir: string): Promise<string> {
  const paths = (await files(dir)).map((p) => Buffer.from(p, "utf8")).sort(Buffer.compare);
  const h = createHash("sha256");
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  };
  for (const p of paths) {
    const c = await fsp.readFile(path.join(dir, p.toString("utf8")));
    h.update(u64(p.length)).update(p).update(u64(c.length)).update(c);
  }
  return `sha256-${h.digest("hex")}`;
}

export async function frontmatter(file: string): Promise<Record<string, any>> {
  const text = await fsp.readFile(file, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  return (parseYaml(m[1]!) as Record<string, any>) ?? {};
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(problems: string[], what: string): void {
  expect(problems, `${what} is inconsistent`).toEqual([]);
}

let agentIdsCache: string[] | null = null;
/** Valid agent ids, from the CLI's own diagnostic (so the list never goes stale). */
async function validAgents(w: World): Promise<string[]> {
  if (agentIdsCache) return agentIdsCache;
  const r = await w.run(["list", "-a", "definitely-not-an-agent"]);
  const line = r.stdout.split("\n").find((l) => l.startsWith("Valid agents:"));
  if (!line) throw new Error(`no "Valid agents:" line in:\n${r.stdout}${r.stderr}`);
  agentIdsCache = line.slice("Valid agents:".length).split(",").map((s) => s.trim()).filter(Boolean);
  return agentIdsCache;
}

// --- store ---------------------------------------------------------------------------------------

export interface StoreRecord {
  id: string;
  source: { type: "git" | "folder" | "file"; url: string; ref: string | null; path: string };
  dir: string;
  versions: Record<string, { commit?: string; tree?: string; hash: string; name: string; description: string; addedAt: string }>;
  current: string;
  global: boolean;
  agents: "all" | string[];
  addedAt: string;
  updatedAt: string;
}

export interface StoreIndex {
  version: 1;
  skills: StoreRecord[];
}

/**
 * The library is consistent: index.json is a version-1 index sorted by id; every version folder
 * exists, holds a regular SKILL.md whose frontmatter matches the record, and hashes to the recorded
 * hash; version keys follow the commit/hash rule; no lock, staging or temp files are left behind;
 * no skill folder is orphaned. Returns the index (empty when the library doesn't exist).
 */
export async function validateStore(w: World, store = w.store): Promise<StoreIndex> {
  const problems: string[] = [];
  const indexFile = path.join(store, "index.json");
  if (!(await exists(indexFile))) {
    if (await exists(path.join(store, "skills"))) problems.push("skills/ exists without index.json");
    fail(problems, "store");
    return { version: 1, skills: [] };
  }
  const index = await readJson<StoreIndex>(indexFile);
  if (index.version !== 1) problems.push(`index version ${index.version}`);
  if (!Array.isArray(index.skills)) {
    fail([...problems, "skills is not an array"], "store");
    return index;
  }
  const ids = index.skills.map((r) => r.id);
  if (new Set(ids).size !== ids.length) problems.push(`duplicate ids: ${ids}`);
  if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) problems.push(`index not sorted by id: ${ids}`);
  const agents = await validAgents(w);
  const dirs = new Set<string>();
  for (const r of index.skills) {
    const at = (m: string) => problems.push(`${r.id}: ${m}`);
    if (!/^(repo|home|path|local):\/\//.test(r.id)) at("unknown id prefix");
    if (!["git", "folder", "file"].includes(r.source?.type)) at(`source.type ${r.source?.type}`);
    if (r.source.type === "git" && !r.id.startsWith("repo://")) at("git source without a repo:// id");
    if (r.source.type !== "git" && r.id.startsWith("repo://") && !r.id.startsWith("repo://")) at("folder source with a repo:// id");
    const m = r.dir.match(/^skills\/[a-z0-9._-]+-([0-9a-f]{8})$/);
    if (!m) at(`dir ${r.dir} is not skills/<slug>-<8 hex>`);
    else if (m[1] !== sha256(r.id).slice(0, 8)) at(`dir suffix ${m[1]} is not sha256(id)[:8]`);
    dirs.add(r.dir);
    if (!r.versions[r.current]) at(`current ${r.current} is not a version`);
    if (typeof r.global !== "boolean") at("global is not a boolean");
    if (r.agents !== "all" && !(Array.isArray(r.agents) && r.agents.length > 0 && r.agents.every((a) => agents.includes(a)))) at(`agents ${JSON.stringify(r.agents)}`);
    if (!ISO.test(r.addedAt) || !ISO.test(r.updatedAt)) at("addedAt/updatedAt are not ISO timestamps");
    for (const [key, v] of Object.entries(r.versions)) {
      const vat = (msg: string) => at(`version ${key}: ${msg}`);
      if (!HASH.test(v.hash)) vat(`hash ${v.hash}`);
      if (v.commit !== undefined) {
        if (!SHA.test(v.commit)) vat(`commit ${v.commit}`);
        if (!(key.length >= 12 && v.commit.startsWith(key))) vat("key is not a commit prefix");
      } else if (!(key.startsWith("h-") && key.length >= 14 && v.hash.slice(7).startsWith(key.slice(2)))) {
        vat("key is not h-<hash prefix>");
      }
      const vdir = path.join(store, r.dir, key);
      const md = await fsp.lstat(path.join(vdir, "SKILL.md")).catch(() => null);
      if (!md?.isFile()) {
        vat("SKILL.md missing or not a regular file");
        continue;
      }
      const actual = await contentHash(vdir);
      if (actual !== v.hash) vat(`content hash ${actual} != recorded ${v.hash}`);
      const fm = await frontmatter(path.join(vdir, "SKILL.md"));
      if (String(fm.name).trim() !== v.name) vat(`frontmatter name ${fm.name} != ${v.name}`);
      if (typeof fm.description !== "string" || !fm.description.replace(/\s+/g, " ").trim().startsWith(v.description.slice(0, 20))) vat("description differs from SKILL.md");
    }
    const onDisk = await fsp.readdir(path.join(store, r.dir)).catch(() => [] as string[]);
    for (const d of onDisk) if (!r.versions[d]) at(`stray folder ${r.dir}/${d}`);
  }
  for (const d of await fsp.readdir(path.join(store, "skills")).catch(() => [] as string[])) {
    if (!dirs.has(`skills/${d}`)) problems.push(`orphaned skill folder skills/${d}`);
  }
  for (const leftover of await leftovers(store)) problems.push(`left behind: ${leftover}`);
  fail(problems, "store");
  return index;
}

/** Lock, staging, temp and backup files anywhere in the library (outside the sync clone's .git). */
async function leftovers(store: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fsp.readdir(path.join(store, rel), { withFileTypes: true }).catch(() => [])) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git") continue;
      if (/\.lock$|\.reclaim$|\.tmp$|\.old-[0-9a-f]+$/.test(e.name)) out.push(p);
      if (e.name === ".staging") {
        const staged = await fsp.readdir(path.join(store, p)).catch(() => [] as string[]);
        if (staged.length > 0) out.push(`${p}/ (${staged.length} entries)`);
        continue;
      }
      if (e.isDirectory()) await walk(p);
    }
  };
  await walk("");
  return out;
}

// --- project manifest ----------------------------------------------------------------------------

export interface Manifest {
  version: 1;
  skills: Record<string, { name?: string; source?: string; ref?: string | null; path?: string; commit?: string; hash?: string; agents: "all" | string[] }>;
}

/**
 * skill-library.json follows the format (sorted keys, field order, entry rules) and, unless
 * `installed: false`, every pinned entry is in the library at exactly its pin.
 */
export async function validateManifest(w: World, projectRoot: string, opts: { installed?: boolean; store?: string } = {}): Promise<Manifest> {
  const problems: string[] = [];
  const file = path.join(projectRoot, "skill-library.json");
  const text = await fsp.readFile(file, "utf8");
  const m = JSON.parse(text) as Manifest;
  if (m.version !== 1) problems.push(`version ${m.version}`);
  const keys = Object.keys(m.skills);
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) problems.push("entries not sorted by id");
  if (!text.endsWith("\n")) problems.push("no trailing newline");
  const index = await readJson<StoreIndex>(path.join(opts.store ?? w.store, "index.json")).catch(() => ({ version: 1, skills: [] }) as StoreIndex);
  const agents = await validAgents(w);
  const order = ["name", "source", "ref", "path", "commit", "hash", "agents"];
  for (const [id, e] of Object.entries(m.skills)) {
    const at = (msg: string) => problems.push(`${id}: ${msg}`);
    const fields = Object.keys(e);
    if (JSON.stringify(fields) !== JSON.stringify(order.filter((k) => fields.includes(k)))) at(`field order ${fields}`);
    if (e.agents !== "all" && !(Array.isArray(e.agents) && e.agents.every((a) => agents.includes(a)))) at(`agents ${JSON.stringify(e.agents)}`);
    if (id.startsWith("local://")) {
      const rel = id.slice("local://".length);
      if (rel.split("/").includes("..") || rel.startsWith("/")) at("local:// escapes the project");
      if (e.source !== undefined || e.hash !== undefined) at("local:// entries carry no source/hash");
      if (!(await exists(path.join(projectRoot, rel, "SKILL.md")))) at("local:// folder has no SKILL.md");
      continue;
    }
    if (!e.source) at("no source");
    if (!e.hash || !HASH.test(e.hash)) at(`hash ${e.hash}`);
    if (id.startsWith("repo://")) {
      if (!e.commit || !SHA.test(e.commit)) at(`commit ${e.commit}`);
      // The id is fixed when the skill is added; `name` follows upstream renames, so they may differ.
    } else if (id.startsWith("home://") || id.startsWith("path://")) {
      if (e.commit !== undefined) at("folder entry has a commit");
    } else at("unknown id prefix");
    if (opts.installed === false) continue;
    const rec = index.skills.find((r) => r.id === id);
    if (!rec) {
      at("not in the library");
      continue;
    }
    const v = Object.values(rec.versions).find((x) => (e.commit ? x.commit === e.commit : x.commit === undefined) && x.hash === e.hash);
    if (!v) at("pinned version not in the library");
    else if (e.name !== undefined && v.name !== e.name) at(`name ${e.name} != library ${v.name}`);
  }
  for (const lock of ["skill-library.json.lock", "skill-library.json.lock.reclaim"]) if (await exists(path.join(projectRoot, lock))) problems.push(`left behind: ${lock}`);
  fail(problems, file);
  return m;
}

// --- gateway -------------------------------------------------------------------------------------

/** The gateway skill in each folder is byte-identical to the packaged one. */
export async function validateGateway(dirs: string[]): Promise<void> {
  const want = await fsp.readFile(path.join(e2e().repoRoot, "skills", "skill-library", "SKILL.md"), "utf8");
  const problems: string[] = [];
  for (const d of dirs) {
    const file = path.join(d, "skill-library", "SKILL.md");
    const st = await fsp.lstat(path.join(d, "skill-library")).catch(() => null);
    if (!st) problems.push(`${file} missing`);
    else if (st.isSymbolicLink()) problems.push(`${file} is a symlink`);
    else if ((await fsp.readFile(file, "utf8").catch(() => "")) !== want) problems.push(`${file} differs from the packaged gateway`);
  }
  fail(problems, "gateway");
}

// --- sync ----------------------------------------------------------------------------------------

/**
 * Sync state is consistent: sync.json has the documented shape; the clone is a git repo whose origin
 * is the configured URL; its skill-library.json only holds valid repo:// entries; every id the repo
 * manages is a global skill in the library at the repo's pin; with `settled`, the clone has no
 * uncommitted changes and nothing unpushed.
 */
export async function validateSync(w: World, opts: { settled?: boolean } = {}): Promise<{ url: string; enabled: boolean; managed: string[] }> {
  const problems: string[] = [];
  const cfg = await readJson(path.join(w.store, "sync.json"));
  if (typeof cfg.url !== "string" || typeof cfg.enabled !== "boolean" || !Array.isArray(cfg.managed)) problems.push(`sync.json shape ${JSON.stringify(cfg)}`);
  const clone = path.join(w.store, "sync");
  const origin = w.git(clone, ["remote", "get-url", "origin"]);
  if (origin !== cfg.url) problems.push(`clone origin ${origin} != ${cfg.url}`);
  const index = await readJson<StoreIndex>(path.join(w.store, "index.json"));
  const manifestFile = path.join(clone, "skill-library.json");
  if (await exists(manifestFile)) {
    const m = await readJson<Manifest>(manifestFile);
    for (const [id, e] of Object.entries(m.skills)) {
      if (!id.startsWith("repo://")) problems.push(`sync manifest holds non-repo entry ${id}`);
      if (!e.commit || !SHA.test(e.commit) || !e.hash || !HASH.test(e.hash)) problems.push(`sync manifest entry ${id} lacks a commit/hash pin`);
      if (cfg.enabled && opts.settled) {
        const rec = index.skills.find((r) => r.id === id);
        if (!rec) problems.push(`${id} (sync manifest) not in the library`);
        else if (!rec.global) problems.push(`${id} (sync manifest) is not global`);
        else if (rec.versions[rec.current]?.commit !== e.commit) problems.push(`${id} current is not the pinned commit`);
      }
    }
  }
  const own = await fsp.readdir(path.join(clone, "skills")).catch(() => [] as string[]);
  if (cfg.enabled && opts.settled) {
    for (const name of own) {
      const rec = index.skills.find((r) => r.id.startsWith("repo://") && r.id.endsWith(`/${name}`) && r.source.type === "git" && r.source.path === `skills/${name}`);
      if (!rec) {
        problems.push(`own skill ${name} not in the library`);
        continue;
      }
      if (!rec.global) problems.push(`own skill ${name} not global`);
      const hash = await contentHash(path.join(clone, "skills", name));
      if (rec.versions[rec.current]?.hash !== hash) problems.push(`own skill ${name}: library hash != repo folder hash`);
    }
    for (const id of cfg.managed) {
      const rec = index.skills.find((r) => r.id === id);
      if (!rec?.global) problems.push(`managed ${id} is not a global skill`);
    }
  }
  if (opts.settled) {
    const dirty = w.git(clone, ["status", "--porcelain"]);
    if (dirty) problems.push(`clone has uncommitted changes:\n${dirty}`);
    const ahead = w.git(clone, ["rev-list", "--count", "@{u}..HEAD"]);
    if (ahead !== "0") problems.push(`clone has ${ahead} unpushed commit(s)`);
  }
  fail(problems, "sync");
  return cfg;
}

/** Files of a remote's default branch, read through a fresh clone. */
export async function remoteFiles(w: World, url: string): Promise<{ manifest: Manifest | null; skills: string[]; files: string[]; dir: string }> {
  const dir = path.join(w.root, `peek-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  execFileSync("git", ["clone", "-q", url, dir], { env: w.env, stdio: "ignore" });
  const manifest = await readJson<Manifest>(path.join(dir, "skill-library.json")).catch(() => null);
  const skills = (await fsp.readdir(path.join(dir, "skills")).catch(() => [] as string[])).sort();
  const all = (await fsp.readdir(dir)).filter((f) => f !== ".git").sort();
  return { manifest, skills, files: all, dir };
}

// --- JSON outputs (docs/02-cli-spec.md) ----------------------------------------------------------

function shape(problems: string[], where: string, row: Record<string, unknown>, spec: Record<string, (v: unknown) => boolean>, exact = true): void {
  for (const [k, ok] of Object.entries(spec)) if (!ok(row[k])) problems.push(`${where}.${k} = ${JSON.stringify(row[k])}`);
  if (exact) for (const k of Object.keys(row)) if (!(k in spec)) problems.push(`${where} has unexpected key ${k}`);
}
const str = (v: unknown) => typeof v === "string";
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const strArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const num01 = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
const bool = (v: unknown) => typeof v === "boolean";
const oneOf = (...xs: unknown[]) => (v: unknown) => xs.includes(v);
const optional = (f: (v: unknown) => boolean) => (v: unknown) => v === undefined || f(v);

/** `list --json`: [{name, path, scope, agents, source, sourceUrl, sourceType, status, id}]. */
export function assertListJson(rows: unknown): asserts rows is any[] {
  const problems: string[] = [];
  if (!Array.isArray(rows)) problems.push("not an array");
  else
    rows.forEach((r, i) => {
      shape(problems, `[${i}]`, r, {
        name: str,
        path: strOrNull,
        scope: oneOf("global", "project"),
        agents: strArr,
        source: str,
        sourceUrl: strOrNull,
        sourceType: oneOf("git", "local", "folder", "file"),
        status: oneOf("tracked", "untracked", "missing"),
        id: str,
      });
      if (r.status === "missing" && r.path !== null) problems.push(`[${i}] missing with a path`);
      if (r.status !== "missing" && r.path === null) problems.push(`[${i}] ${r.status} without a path`);
    });
  fail(problems, "list --json");
}

/** `add --json`: [{id, name, status, source, ref, hash, path, scope, agents, error?}]. */
export function assertAddJson(rows: unknown): asserts rows is any[] {
  const problems: string[] = [];
  if (!Array.isArray(rows)) problems.push("not an array");
  else
    rows.forEach((r, i) =>
      shape(problems, `[${i}]`, r, {
        id: str,
        name: str,
        status: oneOf("installed", "skipped", "failed"),
        source: str,
        ref: strOrNull,
        hash: (v) => v === null || (typeof v === "string" && HASH.test(v)),
        path: strOrNull,
        scope: oneOf("global", "project"),
        agents: strArr,
        error: optional(str),
      }),
    );
  fail(problems, "add --json");
}

/** `query --json`: {matches: [{id, name, description, path, probability, scope, always}], syncChanges?}. */
export function assertQueryJson(out: unknown): asserts out is { matches: any[]; syncChanges?: any } {
  const problems: string[] = [];
  const o = out as any;
  if (typeof o !== "object" || o === null || !Array.isArray(o.matches)) problems.push("no matches array");
  else {
    for (const k of Object.keys(o)) if (!["matches", "syncChanges"].includes(k)) problems.push(`unexpected key ${k}`);
    o.matches.forEach((m: any, i: number) => {
      shape(problems, `matches[${i}]`, m, { id: str, name: str, description: str, path: str, probability: num01, scope: oneOf("global", "project", "builtin"), always: bool }, false);
      if (m.scope === "builtin" && m.id !== `builtin://${m.name}`) problems.push(`matches[${i}] builtin id ${m.id}`);
      if (m.always && m.probability !== 1) problems.push(`matches[${i}] always with probability ${m.probability}`);
    });
    const scored = o.matches.filter((m: any) => !m.always).map((m: any) => m.probability);
    if (JSON.stringify(scored) !== JSON.stringify([...scored].sort((a: number, b: number) => b - a))) problems.push("scored matches not sorted by probability");
    const firstScored = o.matches.findIndex((m: any) => !m.always);
    if (firstScored >= 0 && o.matches.slice(firstScored).some((m: any) => m.always)) problems.push("always skills not listed first");
    if (o.syncChanges !== undefined) shape(problems, "syncChanges", o.syncChanges, { added: strArr, removed: strArr, updated: strArr, shadowed: optional(strArr) });
  }
  fail(problems, "query --json");
}

/** `self doctor --json`: {checks: [{id, status, message, fix?}], ok}. */
export function assertDoctorJson(out: unknown): asserts out is { checks: { id: string; status: string; message: string; fix?: string }[]; ok: boolean } {
  const problems: string[] = [];
  const o = out as any;
  if (!Array.isArray(o?.checks) || typeof o.ok !== "boolean") problems.push("not {checks, ok}");
  else {
    o.checks.forEach((c: any, i: number) => shape(problems, `checks[${i}]`, c, { id: oneOf("install", "release", "gateway", "api-key", "git", "npm"), status: oneOf("ok", "warn", "fail"), message: str, fix: optional(str) }));
    if (o.ok !== !o.checks.some((c: any) => c.status === "fail")) problems.push("ok disagrees with the checks");
    if (JSON.stringify(o.checks.map((c: any) => c.id)) !== JSON.stringify(["install", "release", "gateway", "api-key", "git"])) problems.push(`check ids ${o.checks.map((c: any) => c.id)}`);
  }
  fail(problems, "self doctor --json");
}

// --- everything at once --------------------------------------------------------------------------

/**
 * Store + every given project's manifest + `list -g --json` agrees with the index (every record
 * listed once, `tracked` exactly when global).
 */
export async function validateAll(w: World, projects: string[] = []): Promise<StoreIndex> {
  const index = await validateStore(w);
  for (const p of projects) await validateManifest(w, p);
  const r = await w.run(["list", "-g", "--json"], { cwd: w.home });
  expect(r.code, r.stderr).toBe(0);
  const rows = r.json();
  assertListJson(rows);
  const problems: string[] = [];
  for (const rec of index.skills) {
    const row = rows.filter((x) => x.id === rec.id);
    if (row.length !== 1) problems.push(`${rec.id} listed ${row.length} times`);
    else if ((row[0].status === "tracked") !== rec.global) problems.push(`${rec.id} status ${row[0].status} but global=${rec.global}`);
  }
  for (const row of rows) if (!index.skills.some((r) => r.id === row.id)) problems.push(`list shows ${row.id}, which is not in the index`);
  fail(problems, "list -g vs index");
  return index;
}
