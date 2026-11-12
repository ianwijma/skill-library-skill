// `query`: candidates, scoring through the TypeSafe API (a local fake), output formats, options and
// failures.
import { describe, expect, onTestFinished, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { e2e, readJson, skillMd, world, type Result, type RunOpts, type World } from "./harness.ts";
import { expectUsageError } from "./contract.ts";
import { fakeTypeSafe, type FakeTypeSafe } from "./fakes.ts";
import { assertQueryJson, validateAll, type StoreIndex } from "./validate.ts";

async function setup(): Promise<{ w: World; ts: FakeTypeSafe; q: (args: string[], opts?: RunOpts) => Promise<Result>; src: string }> {
  const w = await world();
  const ts = await fakeTypeSafe();
  onTestFinished(() => ts.close());
  // Keep the built-in out of the way unless a test scores it.
  ts.scores = { "find-skills": 0.01 };
  const src = await w.dir("src");
  const q = (args: string[], opts: RunOpts = {}) =>
    w.run(["query", ...args], { ...opts, env: { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url, SKILL_LIBRARY_TYPESAFE_API_KEY: "k", ...opts.env } });
  return { w, ts, q, src };
}

/** Add local skills globally: name → [description, extra frontmatter, agents]. */
async function addGlobal(w: World, src: string, skills: Record<string, { description: string; extra?: string; agents?: string[] }>): Promise<void> {
  for (const [name, s] of Object.entries(skills)) {
    await w.write(src, { [`${name}/SKILL.md`]: skillMd(name, s.description, `Body of ${name}.`, s.extra ?? "") });
    await w.ok(["add", path.join(src, name), "-g", "-y", ...(s.agents ? ["-a", ...s.agents] : [])]);
  }
  await validateAll(w);
}

const CATALOG = {
  frontend: { description: "Build web frontend interfaces with React" },
  postgres: { description: "Design postgres database schemas" },
  docker: { description: "Write docker images and compose files" },
};

describe("query", () => {
  test("text output: header, name (NN%), └ path to the exact version's SKILL.md; sorted; threshold applied", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    ts.scores = { frontend: 0.91, postgres: 0.75, docker: 0.69, "find-skills": 0.82 };
    const r = await q(["build a react page"]);
    expect(r.code, r.stderr).toBe(0);
    const index = await readJson<StoreIndex>(path.join(w.store, "index.json"));
    const pathOf = (name: string) => {
      const rec = index.skills.find((s) => s.versions[s.current]!.name === name)!;
      return path.join(w.store, rec.dir, rec.current, "SKILL.md");
    };
    const builtin = path.join(e2e().prefix, "lib", "node_modules", "skill-library", "dist", "builtin", "find-skills", "SKILL.md");
    expect(r.stdout).toBe(
      [
        "Read these skill files before continuing with the task:",
        "",
        "frontend (91%)",
        `└ ${pathOf("frontend")}`,
        "",
        "find-skills (82%, built-in)",
        `└ ${builtin}`,
        "",
        "postgres (75%)",
        `└ ${pathOf("postgres")}`,
        "",
      ].join("\n"),
    );
    // The printed paths are the files that were added.
    expect(await fsp.readFile(pathOf("frontend"), "utf8")).toBe(await fsp.readFile(path.join(src, "frontend", "SKILL.md"), "utf8"));
    expect(await fsp.readFile(builtin, "utf8")).toBe(await fsp.readFile(path.join(e2e().repoRoot, "assets", "builtin", "find-skills", "SKILL.md"), "utf8"));
    // query writes nothing to the library.
    await validateAll(w);
  });

  test("request shape: one request, jev-latest, opaque keys, one noul per skill, bearer key, no local paths or ids", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    await q(["design a postgres schema"]);
    const posts = ts.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    const req = posts[0]!;
    expect(req.url).toBe("/v1/systemone");
    expect(req.headers.authorization).toBe("Bearer k");
    expect(req.body.model).toBe("jev-latest");
    expect(req.body.state).toEqual({ task: "design a postgres schema" });
    const keys = Object.keys(req.body.questions);
    expect(keys.sort()).toEqual(["s0", "s1", "s2", "s3"]);
    for (const qn of Object.values<any>(req.body.questions)) {
      expect(qn.type).toBe("noul");
      expect(Object.keys(qn.instructions.skill).sort()).toEqual(["description", "name"]);
      expect(qn.instructions.question).toBe("Would reading the skill `skill.name`, described below, improve how the assistant handles `state.task`?");
      expect(Object.keys(qn.criteria).sort()).toEqual(["false", "true"]);
    }
    expect(ts.lastAsked()).toEqual(["docker", "find-skills", "frontend", "postgres"]);
    const body = JSON.stringify(req.body);
    expect(body).not.toContain(w.root);
    expect(body).not.toContain("path://");
    expect(body).not.toContain("repo://");
  });

  test("--json: one JSON value with the documented shape; scopes and builtin ids", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    ts.scores = { frontend: 0.9, "find-skills": 0.8 };
    const r = await q(["react frontend", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json();
    assertQueryJson(out);
    expect(out.matches.map((m) => [m.name, m.scope, m.probability, m.always])).toEqual([
      ["frontend", "global", 0.9, false],
      ["find-skills", "builtin", 0.8, false],
    ]);
    expect(out.matches[0].id).toBe(`path://${path.join(src, "frontend")}`);
    expect(out.matches[0].description).toBe("Build web frontend interfaces with React");
    expect(out.syncChanges).toBeUndefined();
    expect(r.stderr).toBe("");
  });

  test("--threshold: 0, 0.5, 1 (and =value) filter; invalid values exit 1", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    ts.scores = { frontend: 1, postgres: 0.6, docker: 0.3, "find-skills": 0 };
    const names = async (args: string[]) => {
      const r = await q(["task", "--json", ...args]);
      expect(r.code, r.stderr).toBe(0);
      return r.json().matches.map((m: any) => m.name);
    };
    expect(await names([])).toEqual(["frontend"]);
    expect(await names(["--threshold", "0"])).toEqual(["frontend", "postgres", "docker", "find-skills"]);
    expect(await names(["--threshold", "0.5"])).toEqual(["frontend", "postgres"]);
    expect(await names(["--threshold=0.3"])).toEqual(["frontend", "postgres", "docker"]);
    expect(await names(["--threshold", "1"])).toEqual(["frontend"]);
    for (const bad of ["-0.1", "1.5", "abc", "NaN", "Infinity"]) {
      const r = await q(["task", `--threshold=${bad}`]);
      expect(r.code, bad).toBe(1);
      expect(r.stderr).toContain("--threshold must be a number between 0 and 1");
    }
    expectUsageError(await q(["task", "--threshold"]), "--threshold");
    // -0.5 is rejected, whether it is read as an option (a missing value) or as a number (out of range).
    expectUsageError(await q(["task", "--threshold", "-0.5"]), "--threshold");
  });

  test("empty or blank --threshold / --top values are usage errors, never read as 0", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    for (const [args, option] of [
      [["--threshold="], "--threshold"],
      [["--top="], "--top"],
      [["--agent="], "--agent"],
      [["--threshold", " "], "--threshold"],
      [["--threshold", ""], "--threshold"],
      [["--top", " "], "--top"],
    ] as const) {
      const r = await q(["task", ...args]);
      expectUsageError(r, option);
      expect(r.stdout).toBe("");
    }
    expect(ts.requests).toHaveLength(0);
  });

  test("--top: truncates after sorting; invalid values exit 1", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    ts.scores = { frontend: 0.8, postgres: 0.95, docker: 0.9, "find-skills": 0 };
    const top = async (n: string) => (await q(["task", "--json", "--top", n])).json().matches.map((m: any) => m.name);
    expect(await top("1")).toEqual(["postgres"]);
    expect(await top("2")).toEqual(["postgres", "docker"]);
    expect(await top("10")).toEqual(["postgres", "docker", "frontend"]);
    for (const bad of ["0", "1.5", "x", "-1"]) {
      const r = await q(["task", "--top", bad]);
      expectUsageError(r, "--top");
      if (bad !== "-1") expect(r.stderr, bad).toContain("--top must be a positive integer");
    }
    expectUsageError(await q(["task", "--top"]), "--top");
  });

  test("-a / --agent: agent-specific skills only reach their agent (and the API); invalid agent exits 1", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, {
      general: { description: "General purpose helper" },
      codexy: { description: "Codex configuration helper", agents: ["codex"] },
      claudy: { description: "Claude configuration helper", agents: ["claude-code", "cursor"] },
    });
    ts.scores = { general: 0.9, codexy: 0.9, claudy: 0.9, "find-skills": 0 };
    const asked = async (args: string[]) => {
      const r = await q(["help me", "--json", ...args]);
      expect(r.code, r.stderr).toBe(0);
      return { asked: ts.lastAsked(), got: r.json().matches.map((m: any) => m.name).sort() };
    };
    expect(await asked(["-a", "codex"])).toEqual({ asked: ["codexy", "find-skills", "general"], got: ["codexy", "general"] });
    expect(await asked(["--agent", "claude-code"])).toEqual({ asked: ["claudy", "find-skills", "general"], got: ["claudy", "general"] });
    expect(await asked(["--agent=cursor"])).toEqual({ asked: ["claudy", "find-skills", "general"], got: ["claudy", "general"] });
    expect(await asked(["-a", "opencode"])).toEqual({ asked: ["find-skills", "general"], got: ["general"] });
    // Without -a every skill is a candidate.
    expect((await asked([])).asked).toEqual(["claudy", "codexy", "find-skills", "general"]);

    const before = ts.requests.length;
    const bad = await q(["help me", "-a", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Invalid agents: nope");
    expect(bad.stderr).toContain("Valid agents:");
    expect(bad.stderr).toContain("claude-code");
    expect(ts.requests.length).toBe(before);
    expectUsageError(await q(["help me", "-a"]), "-a", "--agent");
  });

  test("task text: from stdin with -, never empty, one positional only", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    const piped = await q(["-", "--json"], { stdin: "  dockerize the app with docker compose\n" });
    expect(piped.code, piped.stderr).toBe(0);
    expect(piped.json().matches.map((m: any) => m.name)).toEqual(["docker"]);
    expect(ts.requests.at(-1)!.body.state.task).toBe("dockerize the app with docker compose");
    // No positional at all, without a TTY, reads stdin too.
    const implicit = await q(["--json"], { stdin: "postgres tables" });
    expect(implicit.json().matches.map((m: any) => m.name)).toEqual(["postgres"]);

    const n = ts.requests.length;
    for (const [args, stdin] of [[["   "], undefined], [["-"], "  \n\t"], [[""], undefined], [[], ""]] as const) {
      const r = await q([...args], stdin !== undefined ? { stdin } : {});
      expect(r.code, JSON.stringify(args)).toBe(1);
      expect(r.stderr).toContain("task text is empty");
    }
    expectUsageError(await q(["build", "react"]), "react");
    expect(ts.requests.length).toBe(n);
  });

  test("always skills: first, probability 1, not sent, outside --top and --threshold; only-always needs no key", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, {
      rules: { description: "House rules", extra: "metadata:\n  always: true\n" },
      style: { description: "Style guide", extra: 'metadata:\n  always: "true"\n' },
      notalways: { description: "Not always", extra: "metadata:\n  always: false\n" },
      frontend: CATALOG.frontend,
      postgres: CATALOG.postgres,
    });
    ts.scores = { frontend: 0.9, postgres: 0.8, notalways: 0.1, "find-skills": 0 };
    const r = await q(["task", "--json", "--top", "1", "--threshold", "0.85"]);
    const out = r.json();
    assertQueryJson(out);
    expect(out.matches.map((m) => [m.name, m.probability, m.always])).toEqual([
      ["rules", 1, true],
      ["style", 1, true],
      ["frontend", 0.9, false],
    ]);
    expect(ts.lastAsked()).toEqual(["find-skills", "frontend", "notalways", "postgres"]);
    const text = await q(["task"]);
    expect(text.stdout).toContain("rules (always)\n└ ");

    // Only always skills: no request, no key needed.
    const w2 = await world();
    await w2.write(src, {});
    await w2.ok(["add", path.join(src, "rules"), "-g", "-y"]);
    const n = ts.requests.length;
    const nokey = await w2.run(["query", "anything", "--json"], { env: { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url } });
    expect(nokey.code, nokey.stderr).toBe(0);
    expect(nokey.json().matches.map((m: any) => m.name)).toEqual(["rules"]);
    expect(ts.requests.length).toBe(n);
  });

  test("built-in find-skills: scored like any skill, shadowed by a library skill named find-skills; skipped without a key", async () => {
    const { w, ts, q, src } = await setup();
    ts.scores = { "find-skills": 0.9 };
    // Empty library: only the built-in is scored.
    const empty = await q(["find me a skill", "--json"]);
    expect(empty.json().matches.map((m: any) => [m.id, m.scope])).toEqual([["builtin://find-skills", "builtin"]]);
    expect(ts.lastAsked()).toEqual(["find-skills"]);
    // Without a key, built-ins alone never make one required.
    const nokey = await w.run(["query", "find me a skill"], { env: { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url } });
    expect(nokey.code, nokey.stderr).toBe(0);
    expect(nokey.stdout).toBe("No matching skills. Continue without one.\n");

    await addGlobal(w, src, { "find-skills": { description: "My own skill finder" } });
    const mine = await q(["find me a skill", "--json"]);
    const m = mine.json().matches;
    expect(m).toHaveLength(1);
    expect(m[0].scope).toBe("global");
    expect(m[0].description).toBe("My own skill finder");
    expect(ts.lastAsked()).toEqual(["find-skills"]);
    expect(Object.values<any>(ts.requests.at(-1)!.body.questions)[0].instructions.skill.description).toBe("My own skill finder");
  });

  test("project skills: a project skill shadows a global one with the same name; missing project skills are noted", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, { shared: { description: "Global version" }, other: { description: "Other global" } });
    const proj = await w.dir("proj");
    await w.write(proj, { "skills/shared/SKILL.md": skillMd("shared", "Project version") });
    await w.ok(["add", "./skills/shared", "-p", "-y"], { cwd: proj });
    ts.scores = { shared: 0.9, other: 0.8, "find-skills": 0 };
    const r = await q(["task", "--json"], { cwd: proj });
    const out = r.json();
    assertQueryJson(out);
    expect(out.matches.map((m) => [m.name, m.scope, m.description])).toEqual([
      ["shared", "project", "Project version"],
      ["other", "global", "Other global"],
    ]);
    expect(out.matches[0].path).toBe(path.join(proj, "skills", "shared", "SKILL.md"));
    expect(out.matches[0].id).toBe("local://skills/shared");
    expect(ts.lastAsked()).toEqual(["find-skills", "other", "shared"]);
    const text = await q(["task"], { cwd: proj });
    expect(text.stdout).toContain("shared (90%, project)\n");
    await validateAll(w, [proj]);

    // A git skill pinned in the project but not installed on this machine: noted, still shadows.
    const repo = await w.repo("remote", { "SKILL.md": skillMd("other", "Pinned remote other") });
    await w.ok(["add", repo.url, "-p", "-y"], { cwd: proj });
    const m2 = await w.machine("m2");
    const r2 = await m2.run(["query", "task", "--json"], { cwd: proj, env: { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url, SKILL_LIBRARY_TYPESAFE_API_KEY: "k" } });
    expect(r2.code, r2.stderr).toBe(0);
    expect(r2.stderr).toContain("1 project skill is not installed — run skill-library install");
    expect(r2.json().matches.map((m: any) => [m.name, m.scope])).toEqual([["shared", "project"]]);
  });

  test("a skill with an empty description is skipped with a warning", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    // Not reachable through add (it refuses empty descriptions), so blank it in the index.
    const file = path.join(w.store, "index.json");
    const index = await readJson<StoreIndex>(file);
    const rec = index.skills.find((s) => s.versions[s.current]!.name === "docker")!;
    rec.versions[rec.current]!.description = "";
    await fsp.writeFile(file, JSON.stringify(index, null, 2));
    const r = await q(["docker", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("skill 'docker'");
    expect(r.stderr).toContain("has an empty description; excluded from query");
    expect(ts.lastAsked()).toEqual(["find-skills", "frontend", "postgres"]);
  });

  test("nothing passes: the no-match line (text and JSON)", async () => {
    const { w, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    const r = await q(["knit a scarf"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("No matching skills. Continue without one.\n");
    expect((await q(["knit a scarf", "--json"])).json()).toEqual({ matches: [] });
  });

  test("--verbose prints model and usage on stderr only", async () => {
    const { w, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    const r = await q(["react", "--json", "--verbose"]);
    expect(r.code).toBe(0);
    assertQueryJson(r.json());
    expect(r.stderr).toContain('verbose: {"model":"jev-1.13.0","usage":{"input_tokens":100,"output_tokens":10}}');
    expect(r.stdout).not.toContain("verbose");
    expect((await q(["react", "--json"])).stderr).toBe("");
  });

  test("failures exit 2 with diagnostics: no key, 401, 422, 500, unreachable", async () => {
    const { w, ts, q, src } = await setup();
    await addGlobal(w, src, CATALOG);
    const nokey = await w.run(["query", "react"], { env: { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url } });
    expect(nokey.code).toBe(2);
    expect(nokey.stderr).toContain("SKILL_LIBRARY_TYPESAFE_API_KEY is not set (required for query)");
    const blank = await w.run(["query", "react"], { env: { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url, SKILL_LIBRARY_TYPESAFE_API_KEY: "" } });
    expect(blank.code).toBe(2);

    ts.failWith = 401;
    const unauth = await q(["react", "--json"]);
    expect(unauth.code).toBe(2);
    expect(unauth.stderr).toContain("typesafe api returned 401 unauthorized — check SKILL_LIBRARY_TYPESAFE_API_KEY");
    expect(unauth.stdout).toBe("");

    ts.failWith = 422;
    const bad = await q(["react"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("typesafe api 422 (bad question construction):");
    expect(bad.stderr).toContain("forced 422");

    ts.failWith = 500;
    const n = ts.requests.length;
    const server = await q(["react"]);
    expect(server.code).toBe(2);
    expect(server.stderr).toContain("typesafe api 500");
    expect(ts.requests.length - n).toBe(4); // first attempt + 3 retries
    ts.failWith = null;

    const down = await w.run(["query", "react"], { env: { SKILL_LIBRARY_TYPESAFE_API_BASE: "http://127.0.0.1:1", SKILL_LIBRARY_TYPESAFE_API_KEY: "k" } });
    expect(down.code).toBe(2);
    expect(down.stderr).toContain("typesafe api unreachable after 3 retries");
    expect(down.stderr).toContain("skill-library list");
    // Failures never touch the library.
    await validateAll(w);
  });
});
