import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { project, run, sandbox, skillMd, writeFiles, type Sandbox } from "./helpers.ts";

interface MockServer {
  url: string;
  bodies: any[];
  stop: () => void;
}

async function startMock(handler: (body: any, call: number) => Response): Promise<MockServer> {
  const bodies: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const reply = handler(bodies[bodies.length - 1], bodies.length - 1);
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Answer every question with probabilities by skill name. */
function byName(probs: Record<string, number>) {
  return (body: any) =>
    Response.json({
      model: "jev-1.13.0",
      usage: { input_tokens: 535, output_tokens: 58 },
      answers: Object.fromEntries(
        Object.entries(body.questions as Record<string, any>).map(([k, q]) => [k, { type: "noul", noul: probs[q.instructions.skill.name] ?? 0.1 }]),
      ),
    });
}

async function seed(sb: Sandbox): Promise<void> {
  const src = path.join(sb.root, "src");
  await writeFiles(src, {
    "a-skill/SKILL.md": skillMd("a-skill", "Skill A"),
    "b-skill/SKILL.md": skillMd("b-skill", "Skill B"),
    "codex-only/SKILL.md": skillMd("codex-only", "Codex config"),
  });
  expect((await run(sb, ["add", path.join(src, "a-skill"), "-g", "-y"])).code).toBe(0);
  expect((await run(sb, ["add", path.join(src, "b-skill"), "-g", "-y"])).code).toBe(0);
  expect((await run(sb, ["add", path.join(src, "codex-only"), "-g", "-y", "-a", "codex"])).code).toBe(0);
}

function q(sb: Sandbox, args: string[], mock: MockServer, opts: { cwd?: string; stdin?: string } = {}) {
  return run(sb, ["query", ...args], { ...opts, env: { SKILL_LIBRARY_TYPESAFE_API_KEY: "test-key", SKILL_LIBRARY_TYPESAFE_API_BASE: mock.url } });
}

describe("query", () => {
  test("request: one noul question per skill, today's template, opaque keys", async () => {
    const sb = await sandbox();
    await seed(sb);
    const mock = await startMock(byName({}));
    const res = await q(sb, ["fix the buttons"], mock);
    mock.stop();
    expect(res.code).toBe(0);
    const body = mock.bodies[0];
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({ task: "fix the buttons" });
    // Three library skills, then the built-in find-skills.
    expect(Object.keys(body.questions).sort()).toEqual(["s0", "s1", "s2", "s3"]);
    expect(body.questions.s3.instructions.skill.name).toBe("find-skills");
    const question = Object.values(body.questions as Record<string, any>).find((x) => x.instructions.skill.name === "a-skill");
    expect(question).toEqual({
      type: "noul",
      instructions: {
        skill: { name: "a-skill", description: "Skill A" },
        question: "Would reading the skill `skill.name`, described below, improve how the assistant handles `state.task`?",
      },
      criteria: {
        true: "The skill is directly relevant to the task and would change or guide how it is done",
        false: "The skill is unrelated, redundant, or would not meaningfully help",
      },
    });
    // No ids or paths leave the machine.
    expect(JSON.stringify(body)).not.toContain(sb.root);
  });

  test("text output: instruction, matches sorted, path lines; threshold and --top", async () => {
    const sb = await sandbox();
    await seed(sb);
    const mock = await startMock(byName({ "a-skill": 0.78, "b-skill": 0.91, "codex-only": 0.699 }));
    const res = await q(sb, ["task"], mock);
    expect(res.code).toBe(0);
    const lines = res.stdout.split("\n");
    expect(lines[0]).toBe("Read these skill files before continuing with the task:");
    expect(lines[2]).toBe("b-skill (91%)");
    expect(lines[3]).toMatch(/^└ .*\/skills\/b-skill-[0-9a-f]{8}\/h-[0-9a-f]{12}\/SKILL\.md$/);
    expect(lines[5]).toBe("a-skill (78%)");
    expect(res.stdout).not.toContain("codex-only");
    const top = await q(sb, ["task", "--top", "1", "--json"], mock);
    mock.stop();
    const json = JSON.parse(top.stdout);
    expect(json.matches.map((m: any) => m.name)).toEqual(["b-skill"]);
    expect(Object.keys(json.matches[0]).sort()).toEqual(["always", "description", "id", "name", "path", "probability", "scope"]);
    await fsp.access(json.matches[0].path);
  });

  test("always skills: never scored, listed first at probability 1, outside --top", async () => {
    const sb = await sandbox();
    await seed(sb);
    const src = path.join(sb.root, "src");
    await writeFiles(src, {
      "house-rules/SKILL.md": "---\nname: house-rules\ndescription: Team conventions\nmetadata:\n  always: true\n---\n\n# House rules\n",
    });
    expect((await run(sb, ["add", path.join(src, "house-rules"), "-g", "-y"])).code).toBe(0);
    const mock = await startMock(byName({ "a-skill": 0.78, "b-skill": 0.91 }));
    const res = await q(sb, ["task", "--top", "1"], mock);
    expect(res.code).toBe(0);
    const names = Object.values(mock.bodies[0].questions).map((x: any) => x.instructions.skill.name);
    expect(names).not.toContain("house-rules");
    const lines = res.stdout.split("\n");
    expect(lines[2]).toBe("house-rules (always)");
    expect(lines[5]).toBe("b-skill (91%)");
    expect(res.stdout).not.toContain("a-skill");
    const json = JSON.parse((await q(sb, ["task", "--json"], mock)).stdout);
    mock.stop();
    expect(json.matches[0]).toMatchObject({ name: "house-rules", probability: 1, always: true });
    expect(json.matches[1]).toMatchObject({ name: "b-skill", always: false });
  });

  test("only always skills: no API call and no key needed", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.root, "src"), {
      "house-rules/SKILL.md": "---\nname: house-rules\ndescription: Team conventions\nmetadata:\n  always: \"true\"\n---\n",
    });
    expect((await run(sb, ["add", path.join(sb.root, "src", "house-rules"), "-g", "-y"])).code).toBe(0);
    const res = await run(sb, ["query", "task"], { env: { SKILL_LIBRARY_TYPESAFE_API_KEY: "" } });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("house-rules (always)");
  });

  test("built-in find-skills: scored, printed as a command, shown by show, shadowed by a library skill", async () => {
    const sb = await sandbox();
    await seed(sb);
    const mock = await startMock(byName({ "find-skills": 0.82, "a-skill": 0.9 }));
    const res = await q(sb, ["is there a skill for changelogs?"], mock);
    expect(res.code).toBe(0);
    const lines = res.stdout.split("\n");
    expect(lines[2]).toBe("a-skill (90%)");
    expect(lines[5]).toBe("find-skills (82%, built-in)");
    expect(lines[6]).toBe("└ run: skill-library show find-skills");
    const json = JSON.parse((await q(sb, ["task", "--json"], mock)).stdout);
    expect(json.matches[1]).toEqual({
      id: "builtin://find-skills",
      name: "find-skills",
      description: expect.stringContaining("skills.sh"),
      path: "builtin://find-skills",
      probability: 0.82,
      scope: "builtin",
      always: false,
      command: "skill-library show find-skills",
    });

    const shown = await run(sb, ["show", "find-skills"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/^---\nname: find-skills\n/);
    expect(shown.stdout).toContain("skill-library find <query>");
    const bad = await run(sb, ["show", "a-skill"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Built-in skills: find-skills");
    // Nothing is written to disk for built-ins.
    expect((await run(sb, ["list", "-g", "--json"])).stdout).not.toContain("find-skills");

    // A library skill with the same name wins: the built-in is not sent.
    await writeFiles(path.join(sb.root, "src"), { "find-skills/SKILL.md": skillMd("find-skills", "My own finder") });
    expect((await run(sb, ["add", path.join(sb.root, "src", "find-skills"), "-g", "-y"])).code).toBe(0);
    const own = await q(sb, ["task"], mock);
    mock.stop();
    const sent = Object.values(mock.bodies[2].questions).map((x: any) => x.instructions.skill);
    expect(sent.filter((x: any) => x.name === "find-skills").map((x: any) => x.description)).toEqual(["My own finder"]);
    expect(own.stdout).toContain("find-skills (82%)");
    expect(own.stdout).not.toContain("built-in");
  });

  test("-a filters agent-specific skills; invalid agent lists valid ones (exit 1)", async () => {
    const sb = await sandbox();
    await seed(sb);
    const mock = await startMock(byName({ "a-skill": 0.9, "b-skill": 0.9, "codex-only": 0.9 }));
    const claude = await q(sb, ["task", "-a", "claude-code"], mock);
    expect(Object.values(mock.bodies[0].questions).map((x: any) => x.instructions.skill.name)).toEqual(["a-skill", "b-skill", "find-skills"]);
    expect(claude.stdout).not.toContain("codex-only");
    const codex = await q(sb, ["task", "-a", "codex"], mock);
    expect(codex.stdout).toContain("codex-only");
    const bad = await q(sb, ["task", "-a", "claude"], mock);
    mock.stop();
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Invalid agents: claude");
    expect(bad.stderr).toContain("Valid agents: ");
    expect(bad.stderr).toContain("claude-code");
  });

  test("no match message; stdin task; empty library scores only the built-ins", async () => {
    const sb = await sandbox();
    const mock = await startMock(byName({}));
    const empty = await q(sb, ["task"], mock);
    expect(empty.stdout).toBe("No matching skills. Continue without one.\n");
    expect(Object.values(mock.bodies[0].questions).map((x: any) => x.instructions.skill.name)).toEqual(["find-skills"]);
    await seed(sb);
    const res = await q(sb, ["-"], mock, { stdin: "task from stdin" });
    mock.stop();
    expect(res.stdout).toBe("No matching skills. Continue without one.\n");
    expect(mock.bodies[1].state.task).toBe("task from stdin");
  });

  test("project skill shadows a global skill with the same name; missing project skills noted", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(path.join(sb.root, "g"), { "dup/SKILL.md": skillMd("dup", "global copy") });
    await writeFiles(dir, { "skills/dup/SKILL.md": skillMd("dup", "project copy") });
    await run(sb, ["add", path.join(sb.root, "g", "dup"), "-g", "-y"]);
    await run(sb, ["add", "-p", "./skills/dup", "-y"], { cwd: dir });
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, "skill-library.json"), "utf8"));
    manifest.skills["repo://github.com/x/y/gone"] = { source: "https://github.com/x/y.git", ref: null, path: "", commit: "0".repeat(40), hash: `sha256-${"0".repeat(64)}`, agents: "all", name: "gone" };
    await fsp.writeFile(path.join(dir, "skill-library.json"), JSON.stringify(manifest));
    const mock = await startMock(byName({ dup: 0.9 }));
    const res = await q(sb, ["task"], mock, { cwd: dir });
    mock.stop();
    const sent = Object.values(mock.bodies[0].questions).map((x: any) => x.instructions.skill);
    expect(sent.filter((x: any) => x.name === "dup").map((x: any) => x.description)).toEqual(["project copy"]);
    expect(res.stdout).toContain("dup (90%, project)");
    expect(res.stdout).toContain(path.join(dir, "skills", "dup", "SKILL.md"));
    expect(res.stderr).toContain("1 project skill is not installed — run skill-library install");
  });

  test("failures keep exit 2 and the old diagnostics", async () => {
    const sb = await sandbox();
    await seed(sb);
    const unauth = await startMock(() => new Response("nope", { status: 401 }));
    const r401 = await q(sb, ["task"], unauth);
    unauth.stop();
    expect(r401.code).toBe(2);
    expect(r401.stderr).toContain("check SKILL_LIBRARY_TYPESAFE_API_KEY");
    const net = await run(sb, ["query", "task"], { env: { SKILL_LIBRARY_TYPESAFE_API_KEY: "k", SKILL_LIBRARY_TYPESAFE_API_BASE: "http://127.0.0.1:1" } });
    expect(net.code).toBe(2);
    expect(net.stderr).toContain("unreachable after 3 retries");
    expect(net.stdout).toBe("");
    // Only the prefixed variable is read; a general TYPESAFE_API_KEY is ignored.
    const nokey = await run(sb, ["query", "task"], { env: { TYPESAFE_API_KEY: "general-key" } });
    expect(nokey.code).toBe(2);
    expect(nokey.stderr).toContain("SKILL_LIBRARY_TYPESAFE_API_KEY is not set");
  });

  test("reports skills a background sync changed once, then clears them", async () => {
    const sb = await sandbox();
    await seed(sb);
    const unreported = { added: ["zeta"], removed: ["old-one"], updated: [] };
    await fsp.writeFile(path.join(sb.store, "sync-status.json"), JSON.stringify({ unreported }));
    const mock = await startMock(byName({ "b-skill": 0.9 }));

    // A failed query keeps them for later.
    const failed = await run(sb, ["query", "task"]);
    expect(failed.code).toBe(2);

    const first = await q(sb, ["task"], mock);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("b-skill (90%)");
    expect(first.stdout).toContain("Sync changed your global skills — tell the user:\n  added: zeta\n  removed: old-one\n");
    expect(first.stdout).not.toContain("updated:");

    const second = await q(sb, ["task"], mock);
    expect(second.stdout).not.toContain("Sync changed");

    await fsp.writeFile(path.join(sb.store, "sync-status.json"), JSON.stringify({ unreported }));
    const json = await q(sb, ["task", "--json"], mock);
    mock.stop();
    expect(JSON.parse(json.stdout).syncChanges).toEqual(unreported);
  });
});
