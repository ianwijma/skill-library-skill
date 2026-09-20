import { describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.join(import.meta.dir, "..", "src", "index.ts");

interface SliOpts {
  store: string;
  apiBase: string;
  stdin?: string;
  extraArgs?: string[];
}

async function sli(args: string[], opts: SliOpts): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.SKILL_LIBRARY_DIR = opts.store;
  env.TYPESAFE_API_KEY = "test-key";
  env.TYPESAFE_API_BASE = opts.apiBase;
  env.SLI_RETRY_BASE_MS = "10";
  const proc = Bun.spawn([process.execPath, SRC, ...args], {
    env,
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

interface MockServer {
  url: string;
  bodies: any[];
  stop: () => void;
}

function startMock(handler: (body: any, call: number) => Response): MockServer {
  const bodies: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json());
      return handler(bodies[bodies.length - 1], bodies.length - 1);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bodies, stop: () => server.stop(true) };
}

function ok(answers: Record<string, { type: string; noul: number }>, usage = { input_tokens: 535, output_tokens: 58 }): Response {
  return Response.json({ model: "jev-1.13.0", answers, usage });
}

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "sli-query-"));
}

async function writeSkillFile(store: string, name: string, content: string): Promise<string> {
  const file = path.join(store, name);
  await fsp.writeFile(file, content);
  return file;
}

interface Catalog {
  store: string;
  idA: string;
  idB: string;
}

async function seedCatalog(): Promise<Catalog> {
  const store = await tmpDir();
  const f1 = await writeSkillFile(store, "a.md", "content a");
  const f2 = await writeSkillFile(store, "b.md", "content b");
  const recA = JSON.parse(
    (await sli(["add", "--name", "a-skill", "--description", "Skill A", "--path", f1], {
      store,
      apiBase: "http://unused.invalid",
    })).stdout,
  );
  const recB = JSON.parse(
    (await sli(["add", "--name", "b-skill", "--description", "Skill B", "--path", f2], {
      store,
      apiBase: "http://unused.invalid",
    })).stdout,
  );
  return { store, idA: recA.id, idB: recB.id };
}

describe("query request shape", () => {
  test("one request, one noul question per skill, exact template", async () => {
    const { store, idA, idB } = await seedCatalog();
    const mock = startMock(() => ok({}));
    const res = await sli(["query", "fix the buttons"], { store, apiBase: mock.url });
    mock.stop();
    expect(res.code).toBe(0);
    expect(mock.bodies).toHaveLength(1);
    const body = mock.bodies[0];
    expect(body.model).toBe("jev-latest");
    expect(body.state.task).toBe("fix the buttons");
    expect(Object.keys(body.questions).sort()).toEqual([idA, idB].sort());
    const question = body.questions[idA];
    expect(question.type).toBe("noul");
    expect(question.instructions.skill).toEqual({ name: "a-skill", description: "Skill A" });
    expect(question.instructions.question).toBe(
      "Would reading the skill `skill.name`, described below, improve how the assistant handles `state.task`?",
    );
    expect(question.criteria).toEqual({
      true: "The skill is directly relevant to the task and would change or guide how it is done",
      false: "The skill is unrelated, redundant, or would not meaningfully help",
    });
  });

  test("task text from stdin via '-'", async () => {
    const { store } = await seedCatalog();
    const mock = startMock(() => ok({}));
    const res = await sli(["query", "-"], { store, apiBase: mock.url, stdin: "task from stdin\n" });
    mock.stop();
    expect(res.code).toBe(0);
    expect(mock.bodies[0].state.task).toBe("task from stdin");
  });

  test("positional wins over stdin '-'", async () => {
    const { store } = await seedCatalog();
    const mock = startMock(() => ok({}));
    const res = await sli(["query", "positional task", "-"], { store, apiBase: mock.url, stdin: "stdin task" });
    mock.stop();
    expect(res.code).toBe(0);
    expect(mock.bodies[0].state.task).toBe("positional task");
  });

  test("skill with empty description excluded with warning", async () => {
    const store = await tmpDir();
    const f1 = await writeSkillFile(store, "a.md", "content a");
    const f2 = await writeSkillFile(store, "e.md", "empty desc");
    const recA = JSON.parse(
      (await sli(["add", "--name", "a-skill", "--description", "Skill A", "--path", f1], { store, apiBase: "http://unused.invalid" })).stdout,
    );
    await sli(["add", "--name", "empty-desc", "--description", "", "--path", f2], { store, apiBase: "http://unused.invalid" });
    const mock = startMock(() => ok({}));
    const res = await sli(["query", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("empty description");
    expect(Object.keys(mock.bodies[0].questions)).toEqual([recA.id]);
  });
});

describe("answer mapping", () => {
  test("probability mapped, below-threshold excluded", async () => {
    const { store, idA, idB } = await seedCatalog();
    const mock = startMock(() => ok({ [idA]: { type: "noul", noul: 0.91 }, [idB]: { type: "noul", noul: 0.03 } }));
    const res = await sli(["query", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(res.code).toBe(0);
    const matches = JSON.parse(res.stdout).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(idA);
    expect(matches[0].probability).toBe(0.91);
    expect(matches[0].path.endsWith(".md")).toBe(true);
    expect(matches[0].content).toBeUndefined();
  });

  test("threshold edge: 0.7 included at default, 0.699 excluded", async () => {
    const { store, idA } = await seedCatalog();
    const mock = startMock(() => ok({ [idA]: { type: "noul", noul: 0.7 } }));
    const res = await sli(["query", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(JSON.parse(res.stdout).matches).toHaveLength(1);

    const mock2 = startMock(() => ok({ [idA]: { type: "noul", noul: 0.699 } }));
    const res2 = await sli(["query", "task"], { store, apiBase: mock2.url });
    mock2.stop();
    expect(JSON.parse(res2.stdout).matches).toHaveLength(0);
  });

  test("sort desc by probability, tie-break name asc", async () => {
    const { store, idA, idB } = await seedCatalog();
    const mock = startMock(() => ok({ [idA]: { type: "noul", noul: 0.5 }, [idB]: { type: "noul", noul: 0.9 } }));
    const res = await sli(["query", "--threshold", "0.4", "task"], { store, apiBase: mock.url });
    mock.stop();
    let matches = JSON.parse(res.stdout).matches;
    expect(matches.map((m: any) => m.id)).toEqual([idB, idA]);

    const mock2 = startMock(() => ok({ [idA]: { type: "noul", noul: 0.5 }, [idB]: { type: "noul", noul: 0.5 } }));
    const res2 = await sli(["query", "--threshold", "0.4", "task"], { store, apiBase: mock2.url });
    mock2.stop();
    matches = JSON.parse(res2.stdout).matches;
    expect(matches.map((m: any) => m.name)).toEqual(["a-skill", "b-skill"]);
  });

  test("--top truncates after sorting", async () => {
    const { store, idA, idB } = await seedCatalog();
    const mock = startMock(() => ok({ [idA]: { type: "noul", noul: 0.9 }, [idB]: { type: "noul", noul: 0.8 } }));
    const res = await sli(["query", "--top", "1", "task"], { store, apiBase: mock.url });
    mock.stop();
    const matches = JSON.parse(res.stdout).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(idA);
  });

  test("--return-content embeds content", async () => {
    const { store, idA } = await seedCatalog();
    const mock = startMock(() => ok({ [idA]: { type: "noul", noul: 0.9 } }));
    const res = await sli(["query", "--return-content", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(JSON.parse(res.stdout).matches[0].content).toBe("content a");
  });

  test("--verbose logs usage to stderr", async () => {
    const { store } = await seedCatalog();
    const mock = startMock(() => ok({}, { input_tokens: 535, output_tokens: 58 }));
    const res = await sli(["query", "--verbose", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("input_tokens");
  });
});

describe("failure handling", () => {
  test("401 → exit 2, check key hint", async () => {
    const { store } = await seedCatalog();
    const mock = startMock(() => new Response("nope", { status: 401 }));
    const res = await sli(["query", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("check TYPESAFE_API_KEY");
  });

  test("422 → exit 2 with response body", async () => {
    const { store } = await seedCatalog();
    const mock = startMock(() => new Response("bad question construction", { status: 422 }));
    const res = await sli(["query", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("bad question construction");
  });

  test("429 honors Retry-After then succeeds", async () => {
    const { store, idA } = await seedCatalog();
    let calls = 0;
    const mock = startMock(() => {
      calls++;
      if (calls <= 2) return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
      return ok({ [idA]: { type: "noul", noul: 0.95 } });
    });
    const res = await sli(["query", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(res.code).toBe(0);
    expect(calls).toBe(3);
    expect(JSON.parse(res.stdout).matches[0].probability).toBe(0.95);
  });

  test("429 exhausts 3 retries → exit 2", async () => {
    const { store } = await seedCatalog();
    const mock = startMock(() => new Response("overloaded", { status: 429 }));
    const res = await sli(["query", "task"], { store, apiBase: mock.url });
    mock.stop();
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("429 after 3 retries");
    expect(mock.bodies).toHaveLength(4);
  });

  test("network failure retries then exits 2", async () => {
    const { store } = await seedCatalog();
    const res = await sli(["query", "task"], { store, apiBase: "http://127.0.0.1:1" });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unreachable after 3 retries");
  });
});
