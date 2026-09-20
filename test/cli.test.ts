import { describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.join(import.meta.dir, "..", "src", "index.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface SliOpts {
  store: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
}

async function sli(args: string[], opts: SliOpts): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.SKILL_LIBRARY_DIR = opts.store;
  env.TYPESAFE_API_KEY = "";
  delete env.TYPESAFE_API_BASE;
  env.SLI_RETRY_BASE_MS = "10";
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
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

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "sli-cli-"));
}

async function writeSkillFile(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await fsp.writeFile(file, content);
  return file;
}

function jsonOf(res: RunResult): any {
  return JSON.parse(res.stdout);
}

describe("CRUD roundtrip", () => {
  test("add → get → list → update → remove", async () => {
    const store = await tmpDir();
    const src = await writeSkillFile(store, "skill-a.md", "# Skill A\n\ncontent a");
    const addRes = await sli(["add", "--name", "skill-a", "--description", "Test skill A", "--path", src], { store });
    expect(addRes.code).toBe(0);
    expect(addRes.stderr).toBe("");
    const rec = jsonOf(addRes);
    expect(rec.id).toMatch(/^[a-z0-9]{8}$/);
    expect(rec.name).toBe("skill-a");
    expect(rec.description).toBe("Test skill A");
    expect(rec.path).toBe(path.join(store, "skills", rec.id, "SKILL.md"));
    expect(rec.dir).toBe(path.join(store, "skills", rec.id));
    expect(rec.content).toBeUndefined();
    expect(await fsp.readFile(rec.path, "utf8")).toBe("# Skill A\n\ncontent a");

    const got = jsonOf(await sli(["get", rec.id], { store }));
    expect(got.id).toBe(rec.id);
    expect(got.content).toBeUndefined();

    const gotContent = jsonOf(await sli(["get", rec.id, "--return-content"], { store }));
    expect(gotContent.content).toBe("# Skill A\n\ncontent a");

    const listed = jsonOf(await sli(["list"], { store }));
    expect(listed.skills).toHaveLength(1);
    expect(listed.skills[0].id).toBe(rec.id);

    const renamed = jsonOf(await sli(["update", rec.id, "--name", "skill-a-renamed"], { store }));
    expect(renamed.id).toBe(rec.id);
    expect(renamed.name).toBe("skill-a-renamed");

    const srcB = await writeSkillFile(store, "skill-b.md", "# Skill A v2");
    await sli(["update", rec.id, "--path", srcB], { store });
    const refreshed = jsonOf(await sli(["get", rec.id, "--return-content"], { store }));
    expect(refreshed.content).toBe("# Skill A v2");

    const removed = jsonOf(await sli(["remove", rec.id], { store }));
    expect(removed.id).toBe(rec.id);
    expect(removed.content).toBe("# Skill A v2");
    const gone = await sli(["get", rec.id], { store });
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("unknown skill id");
    expect(await fsp.readdir(path.join(store, "skills"))).toEqual([]);
  });

  test("add from directory copies the whole skill dir verbatim", async () => {
    const store = await tmpDir();
    const skillDir = path.join(store, "src-skill");
    await fsp.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "# Multi\n\nrun scripts/tool.py");
    await fsp.writeFile(path.join(skillDir, "scripts", "tool.py"), "print('hi')\n");
    const res = await sli(["add", "--name", "multi", "--description", "Multi-file skill", "--path", skillDir], { store });
    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
    const rec = jsonOf(res);
    expect(rec.dir).toBe(path.join(store, "skills", rec.id));
    expect(await fsp.readFile(path.join(rec.dir, "SKILL.md"), "utf8")).toBe("# Multi\n\nrun scripts/tool.py");
    expect(await fsp.readFile(path.join(rec.dir, "scripts", "tool.py"), "utf8")).toBe("print('hi')\n");

    const listed = jsonOf(await sli(["list"], { store }));
    expect(listed.skills[0].dir).toBe(rec.dir);

    const srcB = path.join(store, "src-skill-v2");
    await fsp.mkdir(srcB, { recursive: true });
    await fsp.writeFile(path.join(srcB, "SKILL.md"), "# Multi v2");
    await sli(["update", rec.id, "--path", srcB], { store });
    const refreshed = jsonOf(await sli(["get", rec.id, "--return-content"], { store }));
    expect(refreshed.content).toBe("# Multi v2");
    expect(await fsp.readdir(rec.dir)).toEqual(["SKILL.md"]);

    const removed = jsonOf(await sli(["remove", rec.id], { store }));
    expect(removed.files).toEqual(["SKILL.md"]);
    expect(await fsp.readdir(path.join(store, "skills"))).toEqual([]);
  });

  test("list sorts by name ascending", async () => {
    const store = await tmpDir();
    const f1 = await writeSkillFile(store, "b.md", "b");
    const f2 = await writeSkillFile(store, "a.md", "a");
    await sli(["add", "--name", "b-name", "--description", "B", "--path", f1], { store });
    await sli(["add", "--name", "a-name", "--description", "A", "--path", f2], { store });
    const listed = jsonOf(await sli(["list"], { store }));
    expect(listed.skills.map((s: any) => s.name)).toEqual(["a-name", "b-name"]);
  });
});

describe("add validation", () => {
  test("missing flags → exit 1", async () => {
    const store = await tmpDir();
    const noName = await sli(["add", "--description", "d", "--path", "/tmp/x.md"], { store });
    expect(noName.code).toBe(1);
    expect(noName.stderr).toContain("--name");
    const noDesc = await sli(["add", "--name", "x", "--path", "/tmp/x.md"], { store });
    expect(noDesc.code).toBe(1);
    const noPath = await sli(["add", "--name", "x", "--description", "d"], { store });
    expect(noPath.code).toBe(1);
  });

  test("bad name → exit 1", async () => {
    const store = await tmpDir();
    const src = await writeSkillFile(store, "s.md", "c");
    for (const name of ["UPPER", "under_score", "-lead"]) {
      const res = await sli(["add", "--name", name, "--description", "d", "--path", src], { store });
      expect(res.code).toBe(1);
    }
  });

  test("missing --path → exit 1", async () => {
    const store = await tmpDir();
    const res = await sli(["add", "--name", "x", "--description", "d", "--path", path.join(store, "nope.md")], { store });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--path not found");
  });

  test("duplicate name → warning on stderr, still proceeds", async () => {
    const store = await tmpDir();
    const src = await writeSkillFile(store, "s.md", "c");
    await sli(["add", "--name", "dup", "--description", "d1", "--path", src], { store });
    const res = await sli(["add", "--name", "dup", "--description", "d2", "--path", src], { store });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("already exists");
    const listed = jsonOf(await sli(["list"], { store }));
    expect(listed.skills).toHaveLength(2);
    expect(listed.skills[0].id).not.toBe(listed.skills[1].id);
  });

  test("store dir missing → auto-created on add", async () => {
    const base = await tmpDir();
    const store = path.join(base, "nested", "store");
    const src = await writeSkillFile(base, "s.md", "c");
    const res = await sli(["add", "--name", "x", "--description", "d", "--path", src], { store });
    expect(res.code).toBe(0);
    expect(await fsp.readdir(path.join(store, "skills"))).toHaveLength(1);
  });
});

describe("update/remove/get validation", () => {
  test("update unknown id → exit 1", async () => {
    const store = await tmpDir();
    const res = await sli(["update", "deadbeef", "--name", "x"], { store });
    expect(res.code).toBe(1);
    expect(res.stderr).toBe("error: unknown skill id 'deadbeef'\n");
  });

  test("update with no flags → exit 1", async () => {
    const store = await tmpDir();
    const src = await writeSkillFile(store, "s.md", "c");
    const rec = jsonOf(await sli(["add", "--name", "x", "--description", "d", "--path", src], { store }));
    const res = await sli(["update", rec.id], { store });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("nothing to update");
  });

  test("update --path unreadable → exit 1", async () => {
    const store = await tmpDir();
    const src = await writeSkillFile(store, "s.md", "c");
    const rec = jsonOf(await sli(["add", "--name", "x", "--description", "d", "--path", src], { store }));
    const res = await sli(["update", rec.id, "--path", path.join(store, "nope.md")], { store });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--path not found");
  });

  test("get unknown id → exit 1", async () => {
    const store = await tmpDir();
    const res = await sli(["get", "deadbeef"], { store });
    expect(res.code).toBe(1);
  });

  test("remove unknown id → exit 1", async () => {
    const store = await tmpDir();
    const res = await sli(["remove", "deadbeef"], { store });
    expect(res.code).toBe(1);
  });
});

describe("store health", () => {
  test("corrupted index → exit 2 with restore hint", async () => {
    const store = await tmpDir();
    await fsp.writeFile(path.join(store, "index.json"), "{oops");
    const res = await sli(["list"], { store });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("index.json is corrupted");
  });

  test("orphaned content dir → stderr warning, exit 0", async () => {
    const store = await tmpDir();
    const src = await writeSkillFile(store, "s.md", "c");
    await sli(["add", "--name", "x", "--description", "d", "--path", src], { store });
    await fsp.mkdir(path.join(store, "skills", "ffffffff"), { recursive: true });
    await fsp.writeFile(path.join(store, "skills", "ffffffff", "SKILL.md"), "orphan");
    const res = await sli(["list"], { store });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("orphaned content dir");
    expect(jsonOf(res).skills).toHaveLength(1);
  });

  test("missing store: list empty, get fails, query needs no key", async () => {
    const base = await tmpDir();
    const store = path.join(base, "missing");
    const listRes = await sli(["list"], { store });
    expect(listRes.code).toBe(0);
    expect(listRes.stdout).toBe('{"skills":[]}\n');
    const getRes = await sli(["get", "deadbeef"], { store });
    expect(getRes.code).toBe(1);
    const qRes = await sli(["query", "any task"], { store });
    expect(qRes.code).toBe(0);
    expect(qRes.stdout).toBe('{"matches":[]}\n');
  });
});

describe("query usage errors", () => {
  test("no task text → exit 1", async () => {
    const store = await tmpDir();
    expect((await sli(["query"], { store })).code).toBe(1);
    expect((await sli(["query", ""], { store })).code).toBe(1);
    expect((await sli(["query", "   "], { store })).code).toBe(1);
    expect((await sli(["query", "-"], { store, stdin: "" })).code).toBe(1);
    expect((await sli(["query", "-"], { store, stdin: "  \n " })).code).toBe(1);
  });

  test("missing TYPESAFE_API_KEY → exit 2 with hint", async () => {
    const store = await tmpDir();
    const src = await writeSkillFile(store, "s.md", "c");
    await sli(["add", "--name", "x", "--description", "d", "--path", src], { store });
    const res = await sli(["query", "task"], { store });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("TYPESAFE_API_KEY is not set");
  });

  test("bad --threshold / --top → exit 1", async () => {
    const store = await tmpDir();
    const r1 = await sli(["query", "--threshold", "1.5", "task"], { store });
    expect(r1.code).toBe(1);
    const r2 = await sli(["query", "--top", "0", "task"], { store });
    expect(r2.code).toBe(1);
    const r3 = await sli(["query", "--top", "abc", "task"], { store });
    expect(r3.code).toBe(1);
  });
});

describe("output conventions", () => {
  test("--pretty indents JSON", async () => {
    const store = await tmpDir();
    const res = await sli(["list", "--pretty"], { store });
    expect(res.stdout).toBe('{\n  "skills": []\n}\n');
  });

  test("--store flag overrides SKILL_LIBRARY_DIR env", async () => {
    const storeA = await tmpDir();
    const storeB = await tmpDir();
    const src = await writeSkillFile(storeA, "s.md", "c");
    await sli(["add", "--name", "x", "--description", "d", "--path", src], { store: storeA });
    expect(jsonOf(await sli(["list"], { store: storeB })).skills).toHaveLength(0);
    const res = await sli(["list", "--store", storeA], { store: storeB });
    expect(jsonOf(res).skills).toHaveLength(1);
  });

  test("--version and --help exit 0", async () => {
    const store = await tmpDir();
    const v = await sli(["--version"], { store });
    expect(v.code).toBe(0);
    expect(v.stdout).toContain("skill-library");
    expect((await sli(["--help"], { store })).code).toBe(0);
    expect((await sli(["list", "--help"], { store })).code).toBe(0);
    expect((await sli(["query", "--help"], { store })).stdout).toContain("--threshold");
  });

  test("unknown command → exit 1", async () => {
    const store = await tmpDir();
    const res = await sli(["frobnicate"], { store });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unknown command");
  });

  test("unknown flag → exit 1", async () => {
    const store = await tmpDir();
    const res = await sli(["list", "--frobnicate"], { store });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unknown flag");
  });
});
