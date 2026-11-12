// Validators: check that what the CLI left on disk is consistent, independently of the CLI's own
// code (the content hash, the store layout and the manifest rules are re-implemented here from
// the docs). Each collects every problem and fails once, listing all of them.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { agentIds } from "../../src/lib/agents.ts";
import { e2e, exists, readJson, type World } from "./harness.ts";

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256-[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SKIP = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);

// --- content hash (docs/03-data-store.md; must never drift) -------------------------------------

async function files(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];

  for (const entry of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) {
      continue;
    }

    const relPath = rel ? `${rel}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...(await files(root, relPath)));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }

  return out;
}

/** sha256 over (u64be len(path) ‖ path ‖ u64be len(content) ‖ content) per file, paths byte-sorted. */
export async function contentHash(dir: string): Promise<string> {
  const paths = (await files(dir)).map((relPath) => Buffer.from(relPath, "utf8")).sort(Buffer.compare);
  const hash = createHash("sha256");

  const u64 = (length: number) => {
    const buffer = Buffer.alloc(8);

    buffer.writeBigUInt64BE(BigInt(length));

    return buffer;
  };

  for (const pathBytes of paths) {
    const content = await fsp.readFile(path.join(dir, pathBytes.toString("utf8")));

    hash.update(u64(pathBytes.length)).update(pathBytes).update(u64(content.length))
      .update(content);
  }

  return `sha256-${hash.digest("hex")}`;
}

export async function frontmatter(file: string): Promise<Record<string, any>> {
  const text = await fsp.readFile(file, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    return {};
  }

  return (parseYaml(match[1]!) as Record<string, any> | null) ?? {};
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(problems: string[], what: string): void {
  expect(problems, `${what} is inconsistent`).toEqual([]);
}

/** Valid agent ids, from the agent registry the CLI is built from (static data, so it never goes
 *  stale and doesn't depend on how any diagnostic is worded). */
async function validAgents(_w: World): Promise<string[]> {
  return agentIds();
}

// --- store ---------------------------------------------------------------------------------------

export interface StoreRecord {
  id: string;
  source: { type: "git" | "folder" | "file"; url: string; ref: string | null; path: string };
  dir: string;
  versions: Record<
    string,
    { commit?: string; tree?: string; hash: string; name: string; description: string; addedAt: string }
  >;
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
export async function validateStore(testWorld: World, store = testWorld.store): Promise<StoreIndex> {
  const problems: string[] = [];
  const indexFile = path.join(store, "index.json");

  if (!(await exists(indexFile))) {
    if (await exists(path.join(store, "skills"))) {
      problems.push("skills/ exists without index.json");
    }

    fail(problems, "store");

    return { version: 1, skills: [] };
  }

  const index = await readJson<StoreIndex>(indexFile);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- index.json is untrusted file content
  if (index.version !== 1) {
    problems.push(`index version ${String(index.version)}`);
  }

  if (!Array.isArray(index.skills)) {
    fail([...problems, "skills is not an array"], "store");

    return index;
  }

  const ids = index.skills.map((record) => record.id);

  if (new Set(ids).size !== ids.length) {
    problems.push(`duplicate ids: ${ids.join(",")}`);
  }

  if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) {
    problems.push(`index not sorted by id: ${ids.join(",")}`);
  }

  const agents = await validAgents(testWorld);
  const dirs = new Set<string>();

  for (const record of index.skills) {
    const at = (message: string) => problems.push(`${record.id}: ${message}`);

    if (!/^(repo|home|path|local):\/\//.test(record.id)) {
      at("unknown id prefix");
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- index.json is untrusted file content
    if (!["git", "folder", "file"].includes(record.source?.type)) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- index.json is untrusted file content
      at(`source.type ${record.source?.type}`);
    }

    if (record.source.type === "git" && !record.id.startsWith("repo://")) {
      at("git source without a repo:// id");
    }

    if (record.source.type !== "git" && record.id.startsWith("repo://")) {
      at(`${record.source.type} source with a repo:// id`);
    }

    const dirMatch = record.dir.match(/^skills\/[a-z0-9._-]+-([0-9a-f]{8})$/);

    if (!dirMatch) {
      at(`dir ${record.dir} is not skills/<slug>-<8 hex>`);
    } else if (dirMatch[1] !== sha256(record.id).slice(0, 8)) {
      at(`dir suffix ${String(dirMatch[1])} is not sha256(id)[:8]`);
    }

    dirs.add(record.dir);

    if (!record.versions[record.current]) {
      at(`current ${record.current} is not a version`);
    }

    if (typeof record.global !== "boolean") {
      at("global is not a boolean");
    }

    if (record.agents !== "all" && !(Array.isArray(record.agents) && record.agents.length > 0 && record.agents.every((agent) => agents.includes(agent)))) {
      at(`agents ${JSON.stringify(record.agents)}`);
    }

    if (!ISO.test(record.addedAt) || !ISO.test(record.updatedAt)) {
      at("addedAt/updatedAt are not ISO timestamps");
    }

    for (const [key, version] of Object.entries(record.versions)) {
      const vat = (msg: string) => at(`version ${key}: ${msg}`);

      if (!HASH.test(version.hash)) {
        vat(`hash ${version.hash}`);
      }

      if (version.commit !== undefined) {
        if (!SHA.test(version.commit)) {
          vat(`commit ${version.commit}`);
        }

        if (!(key.length >= 12 && version.commit.startsWith(key))) {
          vat("key is not a commit prefix");
        }
      } else if (!(key.startsWith("h-") && key.length >= 14 && version.hash.slice(7).startsWith(key.slice(2)))) {
        vat("key is not h-<hash prefix>");
      }

      const vdir = path.join(store, record.dir, key);
      const md = await fsp.lstat(path.join(vdir, "SKILL.md")).catch(() => null);

      if (!md?.isFile()) {
        vat("SKILL.md missing or not a regular file");
        continue;
      }

      const actual = await contentHash(vdir);

      if (actual !== version.hash) {
        vat(`content hash ${actual} != recorded ${version.hash}`);
      }

      const fm = await frontmatter(path.join(vdir, "SKILL.md"));

      if (String(fm.name).trim() !== version.name) {
        vat(`frontmatter name ${fm.name} != ${version.name}`);
      }

      if (typeof fm.description !== "string" || !fm.description.replace(/\s+/g, " ").trim().startsWith(version.description.slice(0, 20))) {
        vat("description differs from SKILL.md");
      }
    }

    const onDisk = await fsp.readdir(path.join(store, record.dir)).catch(() => [] as string[]);

    for (const entryName of onDisk) {
      if (!record.versions[entryName]) {
        at(`stray folder ${record.dir}/${entryName}`);
      }
    }
  }

  for (const folder of await fsp.readdir(path.join(store, "skills")).catch(() => [] as string[])) {
    if (!dirs.has(`skills/${folder}`)) {
      problems.push(`orphaned skill folder skills/${folder}`);
    }
  }

  for (const leftover of await leftovers(store)) {
    problems.push(`left behind: ${leftover}`);
  }

  fail(problems, "store");

  return index;
}

/** Lock, staging, temp and backup files anywhere in the library (outside the sync clone's .git). */
async function leftovers(store: string): Promise<string[]> {
  const out: string[] = [];

  const walk = async (rel: string): Promise<void> => {
    for (const entry of await fsp.readdir(path.join(store, rel), { withFileTypes: true }).catch(() => [])) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.name === ".git") {
        continue;
      }

      if (/\.lock$|\.reclaim$|\.tmp$|\.old-[0-9a-f]+$/.test(entry.name)) {
        out.push(relPath);
      }

      if (entry.name === ".staging") {
        const staged = await fsp.readdir(path.join(store, relPath)).catch(() => [] as string[]);

        if (staged.length > 0) {
          out.push(`${relPath}/ (${staged.length} entries)`);
        }

        continue;
      }

      if (entry.isDirectory()) {
        await walk(relPath);
      }
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
export async function validateManifest(
  testWorld: World,
  projectRoot: string,
  opts: { installed?: boolean; store?: string } = {},
): Promise<Manifest> {
  const problems: string[] = [];
  const file = path.join(projectRoot, "skill-library.json");
  const text = await fsp.readFile(file, "utf8");
  const manifest = JSON.parse(text) as Manifest;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- skill-library.json is untrusted
  if (manifest.version !== 1) {
    problems.push(`version ${String(manifest.version)}`);
  }

  const keys = Object.keys(manifest.skills);

  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    problems.push("entries not sorted by id");
  }

  if (!text.endsWith("\n")) {
    problems.push("no trailing newline");
  }

  const index = await readJson<StoreIndex>(path.join(opts.store ?? testWorld.store, "index.json")).catch(() => ({ version: 1, skills: [] }));
  const agents = await validAgents(testWorld);
  const order = ["name", "source", "ref", "path", "commit", "hash", "agents"];

  for (const [id, entry] of Object.entries(manifest.skills)) {
    const at = (msg: string) => problems.push(`${id}: ${msg}`);
    const fields = Object.keys(entry);

    if (JSON.stringify(fields) !== JSON.stringify(order.filter((field) => fields.includes(field)))) {
      at(`field order ${fields.join(",")}`);
    }

    if (entry.agents !== "all" && !(Array.isArray(entry.agents) && entry.agents.every((agent) => agents.includes(agent)))) {
      at(`agents ${JSON.stringify(entry.agents)}`);
    }

    if (id.startsWith("local://")) {
      const rel = id.slice("local://".length);

      if (rel.split("/").includes("..") || rel.startsWith("/")) {
        at("local:// escapes the project");
      }

      if (entry.source !== undefined || entry.hash !== undefined) {
        at("local:// entries carry no source/hash");
      }

      if (!(await exists(path.join(projectRoot, rel, "SKILL.md")))) {
        at("local:// folder has no SKILL.md");
      }

      continue;
    }

    if (!entry.source) {
      at("no source");
    }

    if (!entry.hash || !HASH.test(entry.hash)) {
      at(`hash ${String(entry.hash)}`);
    }

    if (id.startsWith("repo://")) {
      if (!entry.commit || !SHA.test(entry.commit)) {
        at(`commit ${String(entry.commit)}`);
      }
      // The id is fixed when the skill is added; `name` follows upstream renames, so they may differ.
    } else if (id.startsWith("home://") || id.startsWith("path://")) {
      if (entry.commit !== undefined) {
        at("folder entry has a commit");
      }
    } else {
      at("unknown id prefix");
    }

    if (opts.installed === false) {
      continue;
    }

    const rec = index.skills.find((record) => record.id === id);

    if (!rec) {
      at("not in the library");
      continue;
    }

    const version = Object.values(rec.versions).find(
      (candidate) =>
        (entry.commit ? candidate.commit === entry.commit : candidate.commit === undefined)
        && candidate.hash === entry.hash,
    );

    if (!version) {
      at("pinned version not in the library");
    } else if (entry.name !== undefined && version.name !== entry.name) {
      at(`name ${entry.name} != library ${version.name}`);
    }
  }

  for (const lock of ["skill-library.json.lock", "skill-library.json.lock.reclaim"]) {
    if (await exists(path.join(projectRoot, lock))) {
      problems.push(`left behind: ${lock}`);
    }
  }

  fail(problems, file);

  return manifest;
}

// --- gateway -------------------------------------------------------------------------------------

/** The gateway skill in each folder is byte-identical to the packaged one. */
export async function validateGateway(dirs: string[]): Promise<void> {
  const want = await fsp.readFile(path.join(e2e().repoRoot, "skills", "skill-library", "SKILL.md"), "utf8");
  const problems: string[] = [];

  for (const dir of dirs) {
    const file = path.join(dir, "skill-library", "SKILL.md");
    const st = await fsp.lstat(path.join(dir, "skill-library")).catch(() => null);

    if (!st) {
      problems.push(`${file} missing`);
    } else if (st.isSymbolicLink()) {
      problems.push(`${file} is a symlink`);
    } else if ((await fsp.readFile(file, "utf8").catch(() => "")) !== want) {
      problems.push(`${file} differs from the packaged gateway`);
    }
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
export async function validateSync(
  testWorld: World,
  opts: { settled?: boolean } = {},
): Promise<{ url: string; enabled: boolean; managed: string[] }> {
  const problems: string[] = [];
  const cfg = await readJson(path.join(testWorld.store, "sync.json"));

  if (typeof cfg.url !== "string" || typeof cfg.enabled !== "boolean" || !Array.isArray(cfg.managed)) {
    problems.push(`sync.json shape ${JSON.stringify(cfg)}`);
  }

  const clone = path.join(testWorld.store, "sync");
  const origin = testWorld.git(clone, ["remote", "get-url", "origin"]);

  if (origin !== cfg.url) {
    problems.push(`clone origin ${origin} != ${cfg.url}`);
  }

  const index = await readJson<StoreIndex>(path.join(testWorld.store, "index.json"));
  const manifestFile = path.join(clone, "skill-library.json");

  if (await exists(manifestFile)) {
    const manifest = await readJson<Manifest>(manifestFile);

    for (const [id, entry] of Object.entries(manifest.skills)) {
      if (!id.startsWith("repo://")) {
        problems.push(`sync manifest holds non-repo entry ${id}`);
      }

      if (!entry.commit || !SHA.test(entry.commit) || !entry.hash || !HASH.test(entry.hash)) {
        problems.push(`sync manifest entry ${id} lacks a commit/hash pin`);
      }

      if (cfg.enabled && opts.settled) {
        const rec = index.skills.find((record) => record.id === id);

        if (!rec) {
          problems.push(`${id} (sync manifest) not in the library`);
        } else if (!rec.global) {
          problems.push(`${id} (sync manifest) is not global`);
        } else if (rec.versions[rec.current]?.commit !== entry.commit) {
          problems.push(`${id} current is not the pinned commit`);
        }
      }
    }
  }

  const own = await fsp.readdir(path.join(clone, "skills")).catch(() => [] as string[]);

  if (cfg.enabled && opts.settled) {
    for (const name of own) {
      const rec = index.skills.find((record) => record.id.startsWith("repo://") && record.id.endsWith(`/${name}`) && record.source.type === "git" && record.source.path === `skills/${name}`);

      if (!rec) {
        problems.push(`own skill ${name} not in the library`);
        continue;
      }

      if (!rec.global) {
        problems.push(`own skill ${name} not global`);
      }

      const hash = await contentHash(path.join(clone, "skills", name));

      if (rec.versions[rec.current]?.hash !== hash) {
        problems.push(`own skill ${name}: library hash != repo folder hash`);
      }
    }

    for (const id of cfg.managed) {
      const rec = index.skills.find((record) => record.id === id);

      if (!rec?.global) {
        problems.push(`managed ${id} is not a global skill`);
      }
    }
  }

  if (opts.settled) {
    const dirty = testWorld.git(clone, ["status", "--porcelain"]);

    if (dirty) {
      problems.push(`clone has uncommitted changes:\n${dirty}`);
    }

    const ahead = testWorld.git(clone, ["rev-list", "--count", "@{u}..HEAD"]);

    if (ahead !== "0") {
      problems.push(`clone has ${ahead} unpushed commit(s)`);
    }
  }

  fail(problems, "sync");

  return cfg;
}

/** Files of a remote's default branch, read through a fresh clone. */
export async function remoteFiles(
  testWorld: World,
  url: string,
): Promise<{ manifest: Manifest | null; skills: string[]; files: string[]; dir: string }> {
  const dir = path.join(testWorld.root, `peek-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  execFileSync("git", ["clone", "-q", url, dir], { env: testWorld.env, stdio: "ignore" });
  const manifest = await readJson<Manifest>(path.join(dir, "skill-library.json")).catch(() => null);
  const skills = (await fsp.readdir(path.join(dir, "skills")).catch(() => [] as string[])).sort();
  const all = (await fsp.readdir(dir)).filter((name) => name !== ".git").sort();

  return { manifest, skills, files: all, dir };
}

// --- JSON outputs (docs/02-cli-spec.md) ----------------------------------------------------------

function shape(
  problems: string[],
  where: string,
  row: Record<string, unknown>,
  spec: Record<string, (value: unknown) => boolean>,
  exact = true,
): void {
  for (const [key, ok] of Object.entries(spec)) {
    if (!ok(row[key])) {
      problems.push(`${where}.${key} = ${JSON.stringify(row[key])}`);
    }
  }

  if (exact) {
    for (const key of Object.keys(row)) {
      if (!(key in spec)) {
        problems.push(`${where} has unexpected key ${key}`);
      }
    }
  }
}

const str = (value: unknown) => typeof value === "string";
const strOrNull = (value: unknown) => value === null || typeof value === "string";
const strArr = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
const num01 = (value: unknown) => typeof value === "number" && value >= 0 && value <= 1;
const bool = (value: unknown) => typeof value === "boolean";
const oneOf = (...xs: unknown[]) => (value: unknown) => xs.includes(value);
const optional = (check: (v: unknown) => boolean) => (value: unknown) => value === undefined || check(value);

/** `list --json`: [{name, path, scope, agents, source, sourceUrl, sourceType, status, id}]. */
export function assertListJson(rows: unknown): asserts rows is any[] {
  const problems: string[] = [];

  if (!Array.isArray(rows)) {
    problems.push("not an array");
  } else {
    rows.forEach((row, index) => {
      shape(problems, `[${index}]`, row, {
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

      if (row.status === "missing" && row.path !== null) {
        problems.push(`[${index}] missing with a path`);
      }

      if (row.status !== "missing" && row.path === null) {
        problems.push(`[${index}] ${row.status} without a path`);
      }
    });
  }

  fail(problems, "list --json");
}

/** `add --json`: [{id, name, status, source, ref, hash, path, scope, agents, error?}]. */
export function assertAddJson(rows: unknown): asserts rows is any[] {
  const problems: string[] = [];

  if (!Array.isArray(rows)) {
    problems.push("not an array");
  } else {
    rows.forEach((row, index) =>
      shape(problems, `[${index}]`, row, {
        id: str,
        name: str,
        status: oneOf("installed", "skipped", "failed"),
        source: str,
        ref: strOrNull,
        hash: (value) => value === null || (typeof value === "string" && HASH.test(value)),
        path: strOrNull,
        scope: oneOf("global", "project"),
        agents: strArr,
        error: optional(str),
      }),
    );
  }

  fail(problems, "add --json");
}

/** `query --json`: {matches: [{id, name, description, path, probability, scope, always}], syncChanges?}. */
export function assertQueryJson(out: unknown): asserts out is { matches: any[]; syncChanges?: any } {
  const problems: string[] = [];
  const output = out as any;

  if (typeof output !== "object" || output === null || !Array.isArray(output.matches)) {
    problems.push("no matches array");
  } else {
    for (const key of Object.keys(output)) {
      if (!["matches", "syncChanges"].includes(key)) {
        problems.push(`unexpected key ${key}`);
      }
    }

    output.matches.forEach((match: any, index: number) => {
      shape(problems, `matches[${index}]`, match, { id: str, name: str, description: str, path: str, probability: num01, scope: oneOf("global", "project", "builtin"), always: bool }, false);

      if (match.scope === "builtin" && match.id !== `builtin://${match.name}`) {
        problems.push(`matches[${index}] builtin id ${match.id}`);
      }

      if (match.always && match.probability !== 1) {
        problems.push(`matches[${index}] always with probability ${match.probability}`);
      }
    });
    const scored = output.matches.filter((match: any) => !match.always).map((match: any) => match.probability);

    const sorted = [...scored].sort((left: number, right: number) => right - left);

    if (JSON.stringify(scored) !== JSON.stringify(sorted)) {
      problems.push("scored matches not sorted by probability");
    }

    const firstScored = output.matches.findIndex((match: any) => !match.always);

    if (firstScored >= 0 && output.matches.slice(firstScored).some((match: any) => match.always)) {
      problems.push("always skills not listed first");
    }

    if (output.syncChanges !== undefined) {
      shape(problems, "syncChanges", output.syncChanges, { added: strArr, removed: strArr, updated: strArr, shadowed: optional(strArr) });
    }
  }

  fail(problems, "query --json");
}

/** `self doctor --json`: {checks: [{id, status, message, fix?}], ok}. */
export function assertDoctorJson(
  out: unknown,
): asserts out is { checks: Array<{ id: string; status: string; message: string; fix?: string }>; ok: boolean } {
  const problems: string[] = [];
  const output = out as any;

  if (!Array.isArray(output?.checks) || typeof output.ok !== "boolean") {
    problems.push("not {checks, ok}");
  } else {
    output.checks.forEach((check: any, index: number) => shape(problems, `checks[${index}]`, check, { id: oneOf("install", "release", "gateway", "api-key", "git", "npm"), status: oneOf("ok", "warn", "fail"), message: str, fix: optional(str) }));

    if (output.ok !== !output.checks.some((check: any) => check.status === "fail")) {
      problems.push("ok disagrees with the checks");
    }

    if (JSON.stringify(output.checks.map((check: any) => check.id)) !== JSON.stringify(["install", "release", "gateway", "api-key", "git"])) {
      problems.push(`check ids ${output.checks.map((check: any) => check.id)}`);
    }
  }

  fail(problems, "self doctor --json");
}

// --- everything at once --------------------------------------------------------------------------

/**
 * Store + every given project's manifest + `list -g --json` agrees with the index (every record
 * listed once, `tracked` exactly when global).
 */
export async function validateAll(testWorld: World, projects: string[] = []): Promise<StoreIndex> {
  const index = await validateStore(testWorld);

  for (const project of projects) {
    await validateManifest(testWorld, project);
  }

  const result = await testWorld.run(["list", "-g", "--json"], { cwd: testWorld.home });

  expect(result.code, result.stderr).toBe(0);
  const rows = result.json();

  assertListJson(rows);
  const problems: string[] = [];

  for (const rec of index.skills) {
    const row = rows.filter((listed) => listed.id === rec.id);

    if (row.length !== 1) {
      problems.push(`${rec.id} listed ${row.length} times`);
    } else if ((row[0].status === "tracked") !== rec.global) {
      problems.push(`${rec.id} status ${row[0].status} but global=${rec.global}`);
    }
  }

  for (const row of rows) {
    if (!index.skills.some((record) => record.id === row.id)) {
      problems.push(`list shows ${row.id}, which is not in the index`);
    }
  }

  fail(problems, "list -g vs index");

  return index;
}
