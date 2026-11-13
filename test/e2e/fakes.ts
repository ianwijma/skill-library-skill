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

  // Node ignores the handler's promise, so run it explicitly and mark it as handled.
  const respond = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

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
  };

  const server = http.createServer((req, res) => {
    void respond(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Expose `state`'s keys on `target` as live, settable properties. */
function live<T extends object, S extends object, X extends object>(target: T, state: S, extra: X): T & S & X {
  for (const key of Object.keys(state) as Array<keyof S>) {
    Object.defineProperty(target, key, {
      get: () => state[key],
      set: (value) => (state[key] = value),
      enumerable: true,
    });
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
    .filter((word) => word.length >= 4 && !STOP.has(word));
}

/**
 * Answers like Jev: one noul per question. Deterministic: explicit `scores` first, else 0.92 when a
 * word of the task (4+ letters) appears in the skill's name or description, else 0.04.
 */
export async function fakeTypeSafe(): Promise<FakeTypeSafe> {
  const state = { scores: {} as Record<string, number>, failWith: null as number | null };
  const srv = await serve((req) => {
    if (state.failWith !== null) {
      return { status: state.failWith, body: { error: { type: "error", message: `forced ${state.failWith}` } } };
    }

    if (req.method !== "POST" || !req.url.endsWith("/v1/systemone")) {
      return { status: 404, body: { error: "not found" } };
    }

    const task: string = req.body?.state?.task ?? "";
    const taskWords = new Set(words(task));
    const answers: Record<string, unknown> = {};

    for (const [key, question] of Object.entries<any>(req.body?.questions ?? {})) {
      const skill = question.instructions.skill as { name: string; description: string };
      const explicit = state.scores[skill.name];
      const hit = words(`${skill.name} ${skill.description}`).some((word) => taskWords.has(word));

      answers[key] = { type: "noul", noul: explicit ?? (hit ? 0.92 : 0.04) };
    }

    return { status: 200, body: { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 10 } } };
  });

  return live(srv, state, {
    lastAsked() {
      const last = srv.requests.filter((request) => request.method === "POST").at(-1);

      return last
        ? Object.values<any>(last.body.questions).map((question) => question.instructions.skill.name).sort()
        : [];
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
    if (state.failWith !== null) {
      return { status: state.failWith, body: {} };
    }

    const url = new URL(req.url, "http://x");

    if (url.pathname !== "/api/search") {
      return { status: 404, body: {} };
    }

    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const owner = url.searchParams.get("owner");
    const skills = state.hits.filter(
      (hit) => query.split(/\s+/).some((word) => hit.name.toLowerCase().includes(word) || hit.source.toLowerCase().includes(word)) && (!owner || hit.source.split("/")[0] === owner),
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
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/-/package/skill-library/dist-tags") {
      return { status: 200, body: state.distTags };
    }

    if (pathname === "/skill-library") {
      const vs: Record<string, unknown> = {};

      for (const [version, { manifest, data }] of Object.entries(versions)) {
        vs[version] = {
          ...manifest,
          _id: `skill-library@${version}`,
          dist: {
            tarball: `${base}/skill-library/-/skill-library-${version}.tgz`,
            shasum: createHash("sha1").update(data).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
          },
        };
      }

      return { status: 200, body: { _id: "skill-library", name: "skill-library", "dist-tags": state.distTags, versions: vs } };
    }

    const tgz = pathname.match(/^\/skill-library\/-\/skill-library-(.+)\.tgz$/);

    if (tgz && versions[tgz[1]!]) {
      return { status: 200, body: versions[tgz[1]!]!.data };
    }

    return { status: 404, body: { error: "not found" } };
  });

  base = srv.url;

  return live(srv, state, {
    downloads() {
      return srv.requests.map((request) => request.url.match(/skill-library-(.+)\.tgz$/)?.[1]).filter((version): version is string => !!version);
    },
  });
}

export function basename(filePath: string): string {
  return path.basename(filePath);
}
