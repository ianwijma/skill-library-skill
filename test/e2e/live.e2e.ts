// Opt-in: the real services, read-only. E2E_LIVE=1 adds from a public GitHub repository and searches
// the real skills.sh; with SKILL_LIBRARY_TYPESAFE_API_KEY set it also scores against the real
// TypeSafe API (Jev). CI runs this tier in its own job (.github/workflows/ci.yml, e2e-live).
// Nothing here writes outside the container: no sync, no credentials but the TypeSafe key, and
// pushes are blocked.
//   E2E_LIVE=1 SKILL_LIBRARY_TYPESAFE_API_KEY=… npm run test:e2e -- live
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { PUSH_BLOCK, exists, world } from "./harness.ts";
import { assertQueryJson, validateAll } from "./validate.ts";

const LIVE = process.env.E2E_LIVE === "1";
const KEY = process.env.SKILL_LIBRARY_TYPESAFE_API_KEY;
/** A public repository with several skills (override with E2E_LIVE_SOURCE / E2E_LIVE_SKILL). */
const SOURCE = process.env.E2E_LIVE_SOURCE ?? "anthropics/skills";
const SKILL = process.env.E2E_LIVE_SKILL ?? "frontend-design";

/** Tasks with one obviously right skill in anthropics/skills: the real model must rank it first. */
const TASKS: [task: string, skill: string][] = [
  ["build a polished landing page UI with distinctive styling", "frontend-design"],
  ["extract the tables from this PDF invoice and merge two PDF files", "pdf"],
  ["add a pivot table and formulas to this Excel spreadsheet", "xlsx"],
  ["build an MCP server that exposes our REST API as tools", "mcp-builder"],
];

describe.skipIf(!LIVE)("live services", () => {
  /** Real github.com and skills.sh: a git config without the local rewrite, the real search API. */
  async function liveWorld() {
    const w = await world();
    const gitconfig = path.join(w.root, "live-gitconfig");
    await fsp.writeFile(gitconfig, [...PUSH_BLOCK, ""].join("\n"));
    return { w, env: { GIT_CONFIG_GLOBAL: gitconfig, SKILLS_API_URL: undefined } as Record<string, string | undefined> };
  }

  test("add from real GitHub, list, check", async () => {
    const { w, env } = await liveWorld();
    const listed = await w.ok(["add", SOURCE, "-l"], { env });
    expect(listed.stdout).toContain(SKILL);
    const added = (await w.ok(["add", SOURCE, "-g", "-y", "-s", SKILL, "--json"], { env })).json();
    expect(added.map((r: any) => [r.name, r.status])).toEqual([[SKILL, "installed"]]);
    await validateAll(w);
    expect((await w.ok(["check", "-g"], { env })).stdout).toContain("All skills are up to date.");
  });

  test("find against the real skills.sh: results link to skills.sh; --owner narrows them", async () => {
    const { w, env } = await liveWorld();
    const r = await w.ok(["find", "frontend design"], { env });
    expect(r.stdout).toMatch(/└ https:\/\/skills\.sh\/\S+/);
    const owned = await w.ok(["find", "pdf", "--owner", "anthropics"], { env });
    const links = [...owned.stdout.matchAll(/└ https:\/\/skills\.sh\/(\S+)/g)].map((m) => m[1]!);
    expect(links.length, owned.stdout).toBeGreaterThan(0);
    for (const l of links) expect(l.toLowerCase().startsWith("anthropics/"), l).toBe(true);
  });

  test.skipIf(!KEY)("query against the real TypeSafe API: each task's skill comes first; an unrelated task matches none", async () => {
    const { w, env } = await liveWorld();
    await w.ok(["add", SOURCE, "-g", "-y", "-s", ...new Set(TASKS.map(([, s]) => s))], { env });
    const live = { ...env, SKILL_LIBRARY_TYPESAFE_API_KEY: KEY, SKILL_LIBRARY_TYPESAFE_API_BASE: undefined };
    for (const [task, skill] of TASKS) {
      const out = (await w.ok(["query", task, "--json", "--threshold", "0.3"], { env: live })).json();
      assertQueryJson(out);
      const scored = out.matches.filter((m: any) => !m.always);
      expect(scored[0]?.name, `${task}\n${JSON.stringify(out)}`).toBe(skill);
      expect(await exists(scored[0].path)).toBe(true);
    }
    const none = (await w.ok(["query", "calculate my income tax for 2025", "--json"], { env: live })).json();
    expect(none.matches.filter((m: any) => TASKS.some(([, s]) => s === m.name)), JSON.stringify(none)).toEqual([]);
  });
});
