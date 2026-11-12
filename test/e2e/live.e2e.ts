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

/** The README's example library, and tasks whose answer is obvious: which skills must come back,
 *  and which must never. Set-based, at the default threshold, as a user would run it. */
const README_SKILLS = ["pdf", "xlsx", "frontend-design"];
const TASKS: { task: string; want: string[]; never: string[] }[] = [
  // The README's own examples.
  { task: "pull the totals table out of invoice.pdf into a spreadsheet", want: ["pdf", "xlsx"], never: ["frontend-design"] },
  { task: "build a landing page for a coffee shop", want: ["frontend-design"], never: ["pdf", "xlsx"] },
  // Blunt ones.
  { task: "convert this Excel sheet to a PDF", want: ["pdf", "xlsx"], never: ["frontend-design"] },
  { task: "PDF Excel", want: ["pdf", "xlsx"], never: ["frontend-design"] },
  { task: "merge two PDF files", want: ["pdf"], never: ["xlsx", "frontend-design"] },
  { task: "add a pivot table to this Excel spreadsheet", want: ["xlsx"], never: ["pdf", "frontend-design"] },
  // Nothing to do with any of them.
  { task: "calculate my income tax for 2025", want: [], never: README_SKILLS },
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

  // The real model decides, so CI runs this tier with continue-on-error: a miss is reported, not blocking.
  test.skipIf(!KEY)("query against the real TypeSafe API: the README's library returns the right skills, never the unrelated one", async () => {
    const { w, env } = await liveWorld();
    await w.ok(["add", SOURCE, "-g", "-y", "-s", ...README_SKILLS], { env });
    const live = { ...env, SKILL_LIBRARY_TYPESAFE_API_KEY: KEY, SKILL_LIBRARY_TYPESAFE_API_BASE: undefined };
    const misses: string[] = [];
    for (const { task, want, never } of TASKS) {
      const out = (await w.ok(["query", task, "--json"], { env: live })).json();
      assertQueryJson(out);
      const got = out.matches.filter((m: any) => !m.always);
      const names = got.map((m: any) => m.name);
      for (const m of got) expect(await exists(m.path), m.path).toBe(true);
      const missing = want.filter((n) => !names.includes(n));
      const wrong = never.filter((n) => names.includes(n));
      if (missing.length || wrong.length) misses.push(`"${task}": got [${names.join(", ")}]${missing.length ? `, missing ${missing.join(", ")}` : ""}${wrong.length ? `, unexpected ${wrong.join(", ")}` : ""}`);
    }
    // Every task runs before failing, so one report shows all the misses.
    expect(misses).toEqual([]);
  });
});
