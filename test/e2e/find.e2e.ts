// `find [query] [--owner <owner>]` (aliases search, f, s) against a local skills.sh.
import { describe, expect, onTestFinished, test } from "vitest";
import { exists, world, type World } from "./harness.ts";
import { fakeSkillsSh, type FakeSkillsSh, type SearchHit } from "./fakes.ts";

const HITS: SearchHit[] = [
  { slug: "acme/react-kit/react-hooks", name: "react-hooks", source: "acme/react-kit", installs: 1234 },
  { slug: "acme/react-kit/react-forms", name: "react-forms", source: "acme/react-kit", installs: 1 },
  { slug: "Other/web/react-perf", name: "react-perf", source: "Other/web", installs: 3_400_000 },
  { slug: "other/web/react-a11y", name: "react-a11y", source: "other/web", installs: 999 },
  { slug: "solo/react-new", name: "react-new", source: "", installs: 0 },
  { slug: "acme/react-kit/react-k", name: "react-k", source: "acme/react-kit", installs: 1000 },
];

async function setup(hits = HITS): Promise<{ testWorld: World; api: FakeSkillsSh; find: (args: string[], env?: Record<string, string>) => ReturnType<World["run"]> }> {
  const testWorld = await world();
  const api = await fakeSkillsSh(hits);

  onTestFinished(() => api.close());

  return {
    testWorld,
    api,
    find: (args, env = {}) => testWorld.run(args, { env: { SKILLS_API_URL: api.url, ...env } }),
  };
}

/** Result blocks: "pkg@name [installs]" then "└ https://skills.sh/<slug>". */
function blocks(stdout: string): string[][] {
  const lines = stdout.split("\n");
  const out: string[][] = [];

  lines.forEach((line, lineIndex) => {
    if (lines[lineIndex + 1]?.startsWith("└ ")) {
      out.push([line, lines[lineIndex + 1]!]);
    }
  });

  return out;
}

describe("find", () => {
  test("prints each result as source@name with formatted installs and its skills.sh link", async () => {
    const { testWorld, api, find } = await setup();
    const result = await find(["find", "react"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Install with skill-library add <owner/repo@skill>");
    expect(blocks(result.stdout)).toEqual([
      ["acme/react-kit@react-hooks 1.2K installs", "└ https://skills.sh/acme/react-kit/react-hooks"],
      ["acme/react-kit@react-forms 1 install", "└ https://skills.sh/acme/react-kit/react-forms"],
      ["Other/web@react-perf 3.4M installs", "└ https://skills.sh/Other/web/react-perf"],
      ["other/web@react-a11y 999 installs", "└ https://skills.sh/other/web/react-a11y"],
      // No source: the slug stands in; zero installs print nothing.
      ["solo/react-new@react-new", "└ https://skills.sh/solo/react-new"],
      ["acme/react-kit@react-k 1K installs", "└ https://skills.sh/acme/react-kit/react-k"],
    ]);
    const requestUrl = new URL(api.requests[0]!.url, "http://x");

    expect(requestUrl.pathname).toBe("/api/search");
    expect(requestUrl.searchParams.get("q")).toBe("react");
    expect(requestUrl.searchParams.has("owner")).toBe(false);
    // find never touches the library.
    expect(await exists(testWorld.store)).toBe(false);
  });

  test("aliases search, f and s behave the same; a multi-word query is sent as one q", async () => {
    const { api, find } = await setup();
    const expected = (await find(["find", "react", "hooks"])).stdout;

    for (const alias of ["search", "f", "s"]) {
      const result = await find([alias, "react", "hooks"]);

      expect(result.code, alias).toBe(0);
      expect(result.stdout).toBe(expected);
    }

    expect(api.requests.map((request) => new URL(request.url, "http://x").searchParams.get("q"))).toEqual(Array(4).fill("react hooks"));
  });

  test("--owner and --owner= filter by owner (sent lowercased and trimmed)", async () => {
    const { api, find } = await setup();
    const result = await find(["find", "react", "--owner", "ACME"]);

    expect(result.code).toBe(0);
    expect(blocks(result.stdout).map((block) => block[0]!.split(" ")[0])).toEqual(["acme/react-kit@react-hooks", "acme/react-kit@react-forms", "acme/react-kit@react-k"]);
    const eq = await find(["find", "--owner=acme", "react"]);

    expect(eq.stdout).toBe(result.stdout);
    expect(api.requests.map((request) => new URL(request.url, "http://x").searchParams.get("owner"))).toEqual(["acme", "acme"]);

    const none = await find(["find", "react", "--owner", "nobody"]);

    expect(none.code).toBe(0);
    expect(none.stdout).toContain('No skills found for "react" from owner "nobody"');
  });

  test("an invalid owner is explained and nothing is searched; a missing one is a usage error", async () => {
    const { api, find } = await setup();

    for (const args of [["find", "react", "--owner", "bad/owner"], ["find", "react", "--owner=-x"], ["find", "react", "--owner=a_b"], ["find", "react", `--owner=${"x".repeat(40)}`], ["find", "react", "--owner="], ["find", "react", "--owner=  "]]) {
      const result = await find(args);

      expect(result.code, args.join(" ")).toBe(0);
      expect(result.stderr).toContain("--owner must be a GitHub owner");
      expect(result.stderr).toMatch(/skill-library find/);
    }

    for (const args of [["find", "react", "--owner"], ["find", "react", "--owner", "--json"]]) {
      const result = await find(args);

      expect(result.stdout + result.stderr, args.join(" ")).toContain("--owner");
    }

    expect(api.requests).toEqual([]);
  });

  test("no results, a failing server and an unreachable server all print 'No skills found' and exit 0", async () => {
    const { api, find } = await setup();
    const none = await find(["find", "zzz-nothing"]);

    expect(none.code).toBe(0);
    expect(none.stdout).toContain('No skills found for "zzz-nothing"');
    api.failWith = 500;
    const broken = await find(["find", "react"]);

    expect(broken.code).toBe(0);
    expect(broken.stdout).toContain('No skills found for "react"');
    const offline = await find(["find", "react"], { SKILLS_API_URL: "http://127.0.0.1:1" });

    expect(offline.code).toBe(0);
    expect(offline.stdout).toContain('No skills found for "react"');
  });

  test("no query without a TTY (or inside an agent) prints the agent tip and exits 0", async () => {
    const { api, find } = await setup();

    for (const env of [{}, { AI_AGENT: "claude-code" }, { CLAUDECODE: "1" }] as Array<Record<string, string>>) {
      for (const args of [["find"], ["find", "--owner", "acme"], ["s"]]) {
        const result = await find(args, env);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Tip: if running in a coding agent, follow these steps:");
        expect(result.stdout).toContain("1) skill-library find [query] [--owner <owner>]");
        expect(result.stdout).toContain("2) skill-library add <owner/repo@skill>");
      }
    }

    expect(api.requests).toEqual([]);
    // Inside an agent, a query still searches.
    const inAgent = await find(["find", "react"], { AI_AGENT: "codex" });

    expect(blocks(inAgent.stdout)).toHaveLength(6);
  });

  test("terminal escapes and newlines in results are stripped", async () => {
    const { find } = await setup([{ slug: "evil/x/\x1b]8;;http://bad\x07y", name: "re\x1b[31mact\x1b[0m-x\nfake line", source: "evil/x", installs: 5 }]);
    const result = await find(["find", "evil"]);

    expect(result.code).toBe(0);
    // eslint-disable-next-line no-control-regex -- asserts raw ANSI escapes (ESC) were stripped from untrusted output
    expect(result.rawStdout).not.toMatch(/\x1b\[31m|\x1b\]8/);
    expect(result.stdout).toContain("evil/x@react-x fake line 5 installs");
    expect(result.stdout).toContain("└ https://skills.sh/evil/x/y");
  });
});
