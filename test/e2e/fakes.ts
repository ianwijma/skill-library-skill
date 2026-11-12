// Local stand-ins for the network services skill-library talks to. Each records what it was asked,
// so tests can check the requests as well as the CLI's output.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FakeServer {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

async function serve(handler: (req: Recorded) => Reply | Promise<Reply>): Promise<FakeServer> {
  const requests: Recorded[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // keep the raw text
    }
    const rec: Recorded = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body };
    requests.push(rec);
    try {
      const reply = await handler(rec);
      const isBuffer = Buffer.isBuffer(reply.body);
      res.writeHead(reply.status, { "content-type": isBuffer ? "application/octet-stream" : "application/json", ...reply.headers });
      res.end(isBuffer ? (reply.body as Buffer) : JSON.stringify(reply.body));
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Expose `state`'s keys on `target` as live, settable properties. */
function live<T extends object, S extends object, X extends object>(target: T, state: S, extra: X): T & S & X {
  for (const key of Object.keys(state) as (keyof S)[]) {
    Object.defineProperty(target, key, { get: () => state[key], set: (v) => (state[key] = v), enumerable: true });
  }
  return Object.assign(target, extra) as T & S & X;
}

// --- TypeSafe System One ------------------------------------------------------------------------

export interface FakeTypeSafe extends FakeServer {
  /** Probability by skill name; skills not listed are scored by keyword overlap with the task. */
  scores: Record<string, number>;
  /** Force every request to fail with this status (e.g. 401, 422, 500). */
  failWith: number | null;
  /** The skill names asked about in the last request. */
  lastAsked(): string[];
}

const STOP = new Set(["with", "that", "this", "from", "your", "into", "when", "what", "about", "the", "and", "for"]);
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

/**
 * Answers like Jev: one noul per question. Deterministic: explicit `scores` first, else 0.92 when a
 * word of the task (4+ letters) appears in the skill's name or description, else 0.04.
 */
export async function fakeTypeSafe(): Promise<FakeTypeSafe> {
  const state = { scores: {} as Record<string, number>, failWith: null as number | null };
  const srv = await serve((req) => {
    if (state.failWith !== null) return { status: state.failWith, body: { error: { type: "error", message: `forced ${state.failWith}` } } };
    if (req.method !== "POST" || !req.url.endsWith("/v1/systemone")) return { status: 404, body: { error: "not found" } };
    const task: string = req.body?.state?.task ?? "";
    const taskWords = new Set(words(task));
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries<any>(req.body?.questions ?? {})) {
      const skill = q.instructions.skill as { name: string; description: string };
      const explicit = state.scores[skill.name];
      const hit = words(`${skill.name} ${skill.description}`).some((w) => taskWords.has(w));
      answers[key] = { type: "noul", noul: explicit ?? (hit ? 0.92 : 0.04) };
    }
    return { status: 200, body: { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 10 } } };
  });
  return live(srv, state, {
    lastAsked() {
      const last = srv.requests.filter((r) => r.method === "POST").at(-1);
      return last ? Object.values<any>(last.body.questions).map((q) => q.instructions.skill.name).sort() : [];
    },
  });
}

// --- skills.sh search ---------------------------------------------------------------------------

export interface SearchHit {
  id?: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
}

export interface FakeSkillsSh extends FakeServer {
  hits: SearchHit[];
  failWith: number | null;
}

/** /api/search?q=&owner= → the hits whose name or source contains q (and whose owner matches). */
export async function fakeSkillsSh(hits: SearchHit[] = []): Promise<FakeSkillsSh> {
  const state = { hits, failWith: null as number | null };
  const srv = await serve((req) => {
    if (state.failWith !== null) return { status: state.failWith, body: {} };
    const u = new URL(req.url, "http://x");
    if (u.pathname !== "/api/search") return { status: 404, body: {} };
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    const owner = u.searchParams.get("owner");
    const skills = state.hits.filter(
      (h) => q.split(/\s+/).some((w) => h.name.toLowerCase().includes(w) || h.source.toLowerCase().includes(w)) && (!owner || h.source.split("/")[0] === owner),
    );
    return { status: 200, body: { skills } };
  });
  return live(srv, state, {});
}

// --- npm registry -------------------------------------------------------------------------------

export interface FakeRegistry extends FakeServer {
  distTags: Record<string, string>;
  /** Tarball downloads served, by version. */
  downloads(): string[];
}

/**
 * Enough of the npm registry for `npm i -g skill-library@<v>` and skill-library's dist-tags check:
 * the packument, the tarballs and `/-/package/<name>/dist-tags`.
 */
export async function fakeRegistry(tarballs: string[], distTags: Record<string, string>): Promise<FakeRegistry> {
  const versions: Record<string, { manifest: any; file: string; data: Buffer }> = {};
  for (const file of tarballs) {
    const data = await fsp.readFile(file);
    const manifest = JSON.parse(execFileSync("tar", ["-xzOf", file, "package/package.json"], { encoding: "utf8" }));
    versions[manifest.version] = { manifest, file, data };
  }
  const state = { distTags };
  let base = "";
  const srv = await serve((req) => {
    const u = new URL(req.url, "http://x");
    const p = decodeURIComponent(u.pathname);
    if (p === "/-/package/skill-library/dist-tags") return { status: 200, body: state.distTags };
    if (p === "/skill-library") {
      const vs: Record<string, unknown> = {};
      for (const [v, { manifest, data }] of Object.entries(versions)) {
        vs[v] = {
          ...manifest,
          _id: `skill-library@${v}`,
          dist: {
            tarball: `${base}/skill-library/-/skill-library-${v}.tgz`,
            shasum: createHash("sha1").update(data).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
          },
        };
      }
      return { status: 200, body: { _id: "skill-library", name: "skill-library", "dist-tags": state.distTags, versions: vs } };
    }
    const tgz = p.match(/^\/skill-library\/-\/skill-library-(.+)\.tgz$/);
    if (tgz && versions[tgz[1]!]) return { status: 200, body: versions[tgz[1]!]!.data };
    return { status: 404, body: { error: "not found" } };
  });
  base = srv.url;
  return live(srv, state, {
    downloads() {
      return srv.requests.map((r) => r.url.match(/skill-library-(.+)\.tgz$/)?.[1]).filter((v): v is string => !!v);
    },
  });
}

export function basename(p: string): string {
  return path.basename(p);
}
