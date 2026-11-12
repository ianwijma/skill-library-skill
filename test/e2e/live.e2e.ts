// Opt-in: the real services, read-only. E2E_LIVE=1 adds from a public GitHub repository; with
// SKILL_LIBRARY_TYPESAFE_API_KEY set it also asks the real TypeSafe API. Never part of CI.
// Nothing here writes outside the container: no sync, no credentials, and pushes are blocked.
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

describe.skipIf(!LIVE)("live services", () => {
  /** Real github.com: a git config without the local rewrite. */
  async function liveWorld() {
    const w = await world();
    const gitconfig = path.join(w.root, "live-gitconfig");
    await fsp.writeFile(gitconfig, [...PUSH_BLOCK, ""].join("\n"));
    return { w, env: { GIT_CONFIG_GLOBAL: gitconfig } };
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

  test.skipIf(!KEY)("query against the real TypeSafe API", async () => {
    const { w, env } = await liveWorld();
    await w.ok(["add", SOURCE, "-g", "-y", "-s", SKILL], { env });
    const live = { ...env, SKILL_LIBRARY_TYPESAFE_API_KEY: KEY, SKILL_LIBRARY_TYPESAFE_API_BASE: undefined };
    const r = await w.ok(["query", "build a polished landing page UI with distinctive styling", "--json", "--threshold", "0.3"], { env: live });
    const out = r.json();
    assertQueryJson(out);
    const hit = out.matches.find((m: any) => m.name === SKILL);
    expect(hit, JSON.stringify(out)).toBeDefined();
    expect(await exists(hit.path)).toBe(true);
    const none = (await w.ok(["query", "calculate my income tax for 2025", "--json"], { env: live })).json();
    expect(none.matches.some((m: any) => m.name === SKILL)).toBe(false);
  });
});
