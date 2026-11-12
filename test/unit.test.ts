import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentsMatch, globalKindOf, mergeAgents, subtractAgents, type ScopedSkill } from "../src/core/context.ts";
import { selectCandidates } from "../src/core/query.ts";
import { resolveScopes } from "../src/core/update.ts";
import { hashFiles, hashSkillDir } from "../src/lib/hash.ts";
import { gitSkillId, localSkillId, safeSlug } from "../src/lib/ids.ts";
import { findProjectRoot } from "../src/lib/manifest.ts";
import { parseSource } from "../src/lib/source.ts";
import { versionKeyFor, type StoreRecord } from "../src/lib/store.ts";
import { gatewaySkillMd } from "../src/lib/gateway.ts";
import { newerRelease } from "../src/lib/release.ts";
import { parseFrontmatter } from "../src/lib/frontmatter.ts";
import { formatTimestamp, relativeTime } from "../src/lib/time.ts";
import { newReadme, readmeTitle, repoOwner, shareableUrl } from "../src/lib/sync-readme.ts";

describe("ids", () => {
  test("GitHub over every transport gets the same id", () => {
    const urls = [
      parseSource("Anthropics/Skills").url,
      parseSource("github:anthropics/skills").url,
      parseSource("https://github.com/anthropics/skills").url,
      parseSource("https://github.com/anthropics/skills.git").url,
      "git@github.com:anthropics/skills.git",
      "ssh://git@github.com/anthropics/skills.git",
    ];
    for (const u of urls) expect(gitSkillId(u, "react")).toBe("repo://github.com/anthropics/skills/react");
  });

  test("other hosts keep path case and drop scheme/user/port/.git", () => {
    expect(gitSkillId("https://gitlab.com/Group/Sub/Repo.git", "s")).toBe("repo://gitlab.com/Group/Sub/Repo/s");
    expect(gitSkillId("ssh://git@git.example.com:2222/team/repo.git", "s")).toBe("repo://git.example.com/team/repo/s");
    expect(gitSkillId("git@host.io:team/repo.git", "s")).toBe("repo://host.io/team/repo/s");
  });

  test("local ids: project, home, path", () => {
    const home = os.homedir();
    expect(localSkillId("/work/proj/skills/foo", "/work/proj")).toBe("local://skills/foo");
    expect(localSkillId("/work/proj", "/work/proj")).toBe("local://.");
    expect(localSkillId(path.join(home, "my-skills/foo"), null)).toBe("home://my-skills/foo");
    expect(localSkillId("/opt/skills/foo", null)).toBe("path:///opt/skills/foo");
    // A global add of a folder inside a project never gets a local:// id.
    expect(localSkillId("/opt/proj/skills/foo", null)).toBe("path:///opt/proj/skills/foo");
  });

  test("safe slug", () => {
    expect(safeSlug("React Best/Practices")).toBe("react-best-practices");
    expect(safeSlug("..")).toBe("skill");
  });
});

describe("hash", () => {
  test("fixed test vector (format must never drift)", () => {
    expect(hashFiles({ "SKILL.md": "hello\n", "a/b.txt": "x" })).toBe(
      "sha256-261205b9e6f4d81fef3ac57facec9bc7a7abf9defa275f120dcafb6dcedf130d",
    );
  });

  test("dir hash = file hash, skips junk, non-ASCII and binary safe", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-hash-"));
    await fsp.mkdir(path.join(dir, "a"), { recursive: true });
    await fsp.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fsp.writeFile(path.join(dir, "SKILL.md"), "hello\n");
    await fsp.writeFile(path.join(dir, "a", "b.txt"), "x");
    await fsp.writeFile(path.join(dir, "ünï.bin"), Buffer.from([0, 255, 1]));
    await fsp.writeFile(path.join(dir, ".DS_Store"), "junk");
    await fsp.writeFile(path.join(dir, "node_modules", "x.js"), "junk");
    expect(await hashSkillDir(dir)).toBe(hashFiles({ "SKILL.md": "hello\n", "a/b.txt": "x", "ünï.bin": Buffer.from([0, 255, 1]) }));
  });
});

describe("source parsing", () => {
  test("shorthand, @skill, version pin, #ref, tree URL", () => {
    expect(parseSource("o/r")).toEqual({ type: "git", url: "https://github.com/o/r.git" });
    expect(parseSource("o/r@my-skill")).toEqual({ type: "git", url: "https://github.com/o/r.git", skillFilter: "my-skill" });
    expect(parseSource("o/r@v1.2.3")).toEqual({ type: "git", url: "https://github.com/o/r.git", ref: "v1.2.3" });
    expect(parseSource("o/r#dev@s")).toEqual({ type: "git", url: "https://github.com/o/r.git", ref: "dev", skillFilter: "s" });
    expect(parseSource("https://github.com/o/r/tree/main/skills/x")).toEqual({ type: "git", url: "https://github.com/o/r.git", ref: "main", subpath: "skills/x" });
    expect(parseSource("o/r/skills/x").subpath).toBe("skills/x");
  });

  test("local paths and git URLs", () => {
    expect(parseSource("./x", "/base")).toEqual({ type: "local", url: "/base/x" });
    expect(parseSource("file:///tmp/r.git").type).toBe("git");
    expect(parseSource("git@gitlab.com:g/r.git")).toEqual({ type: "git", url: "git@gitlab.com:g/r.git" });
  });

  test("deferred forms are rejected, never misparsed as git", () => {
    expect(() => parseSource("https://example.com/skills")).toThrow(/not supported by skill-library yet/);
    expect(() => parseSource("https://gitlab.com/g/r/-/tree/main/x")).toThrow(/not supported by skill-library yet/);
    expect(() => parseSource("https://raw.githubusercontent.com/o/r/main/SKILL.md")).toThrow(/not supported/);
    expect(() => parseSource("o/r/../x")).toThrow(/Unsafe subpath/);
  });
});

describe("agent rules (§4)", () => {
  test("merge", () => {
    expect(mergeAgents(undefined, "all")).toBe("all");
    expect(mergeAgents(undefined, ["x"])).toEqual(["x"]);
    expect(mergeAgents("all", ["x"])).toBe("all");
    expect(mergeAgents(["y"], ["x"])).toEqual(["y", "x"]);
    expect(mergeAgents(["y"], "all")).toBe("all");
  });
  test("subtract", () => {
    expect(subtractAgents(["x", "y"], ["x"])).toEqual({ kind: "rest", value: ["y"] });
    expect(subtractAgents(["x"], ["x"])).toEqual({ kind: "empty" });
    expect(subtractAgents("all", ["x"])).toEqual({ kind: "all" });
  });
  test("match", () => {
    expect(agentsMatch("all", "codex")).toBe(true);
    expect(agentsMatch(["claude-code"], "codex")).toBe(false);
    expect(agentsMatch(["claude-code"], undefined)).toBe(true);
  });
});

function sk(p: Partial<ScopedSkill> & { id: string; name: string }): ScopedSkill {
  return { description: "d", scope: "global", kind: "stored", dir: "/x", agents: "all", status: "installed", source: "", sourceType: "git", ...p };
}

describe("query candidate order (§5.1)", () => {
  test("missing project winner still shadows the global skill", () => {
    const r = selectCandidates([sk({ id: "p", name: "foo", scope: "project", status: "missing", dir: null }), sk({ id: "g", name: "foo" })], undefined);
    expect(r.candidates).toEqual([]);
    expect(r.notInstalled).toBe(1);
  });
  test("Claude-only project winner + -a codex still shadows global", () => {
    const r = selectCandidates([sk({ id: "p", name: "foo", scope: "project", agents: ["claude-code"] }), sk({ id: "g", name: "foo" })], "codex");
    expect(r.candidates).toEqual([]);
  });
  test("local:// beats referenced beats global; same-priority clash keeps both", () => {
    const local = sk({ id: "l", name: "foo", scope: "project", kind: "local" });
    const ref = sk({ id: "r", name: "foo", scope: "project" });
    const g1 = sk({ id: "g1", name: "bar" });
    const g2 = sk({ id: "g2", name: "bar" });
    const r = selectCandidates([ref, local, g1, g2, sk({ id: "g3", name: "foo" })], undefined);
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["g1", "g2", "l"]);
  });
});

describe("global name clashes", () => {
  const syncUrl = "https://github.com/me/my-skills.git";
  test("remote beats own beats machine-only", () => {
    const remote = sk({ id: "repo://github.com/typesafe-ai/skills/typesafe-ai", name: "typesafe-ai" });
    const own = sk({ id: "repo://github.com/me/my-skills/typesafe-ai", name: "typesafe-ai" });
    const machine = sk({ id: "home://skills/typesafe-ai", name: "typesafe-ai", sourceType: "local" });
    expect(selectCandidates([own, machine, remote], undefined, syncUrl).candidates.map((c) => c.id)).toEqual([remote.id]);
    expect(selectCandidates([own, machine], undefined, syncUrl).candidates.map((c) => c.id)).toEqual([own.id]);
    expect(globalKindOf(own, syncUrl)).toBe("own");
    expect(globalKindOf(own, null)).toBe("remote");
    expect(globalKindOf(machine, syncUrl)).toBe("machine-only");
  });
});

describe("store", () => {
  test("version key prefix collision gets a longer key, never merges", () => {
    const record = { versions: { "abcdefabcdef": { commit: "abcdefabcdef0000000000000000000000000000", hash: "sha256-1", name: "n", description: "", addedAt: "" } } } as unknown as StoreRecord;
    expect(versionKeyFor(record, { commit: "abcdefabcdef0000000000000000000000000000", hash: "sha256-1" })).toBe("abcdefabcdef");
    expect(versionKeyFor(record, { commit: "abcdefabcdef1111111111111111111111111111", hash: "sha256-2" })).toBe("abcdefabcdef1111");
    expect(versionKeyFor(undefined, { hash: "sha256-0123456789abcdef" })).toBe("h-0123456789ab");
  });

  test("project root lookup: nested first use, ancestor manifest, $HOME", async () => {
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "sl-root-")));
    await fsp.mkdir(path.join(root, "a", "b"), { recursive: true });
    expect(findProjectRoot(path.join(root, "a", "b"))).toEqual({ root: path.join(root, "a", "b"), exists: false });
    await fsp.writeFile(path.join(root, "a", "skill-library.json"), '{"version":1,"skills":{}}');
    expect(findProjectRoot(path.join(root, "a", "b"))).toEqual({ root: path.join(root, "a"), exists: true });
    expect(findProjectRoot(os.homedir())).toBeNull();
  });

  test("update/check scope defaults", () => {
    const proj = { manifest: { version: 1 as const, skills: { x: { agents: "all" as const } } } } as never;
    const empty = { manifest: { version: 1 as const, skills: {} } } as never;
    expect(resolveScopes({}, proj)).toEqual(["project"]);
    expect(resolveScopes({}, empty)).toEqual(["global"]);
    expect(resolveScopes({ skills: ["x"] }, proj)).toEqual(["project", "global"]);
    expect(resolveScopes({ global: true, project: true }, null)).toEqual(["project", "global"]);
  });
});

describe("gateway", () => {
  test("embedded gateway is the repo's skill-library SKILL.md", async () => {
    const md = gatewaySkillMd();
    expect(parseFrontmatter(md).data.name).toBe("skill-library");
    expect(md).toContain("skill-library query -a <your-agent-id>");
    expect(md).toBe(await fsp.readFile(path.join(import.meta.dirname, "..", "skills", "skill-library", "SKILL.md"), "utf8"));
  });
  test("gateway names only the query command and nothing about sync or the store", () => {
    const md = gatewaySkillMd();
    const commands = [...md.matchAll(/skill-library ([a-z-]+)/g)].map((m) => m[1]);
    expect(new Set(commands)).toEqual(new Set(["query"]));
    // --json and the tuning flags are for scripts and people; the agent only needs -a.
    expect(md).not.toMatch(/--json|--threshold|--top|\{"matches"/);
    expect(md).not.toMatch(/\bsync|\bgit\b|\brepo(sitory)?\b|\.local\/share|SKILL_LIBRARY_DIR|--store|list --json|list -g/i);
  });
});

describe("time formatting", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  test("relative time", () => {
    expect(relativeTime(new Date("2026-11-10T11:59:30Z"), now)).toBe("just now");
    expect(relativeTime(new Date("2026-11-10T11:55:00Z"), now)).toBe("5 minutes ago");
    expect(relativeTime(new Date("2026-11-10T09:00:00Z"), now)).toBe("3 hours ago");
    expect(relativeTime(new Date("2026-11-09T12:00:00Z"), now)).toBe("1 day ago");
    expect(relativeTime(new Date("2026-11-05T12:00:00Z"), now)).toBe("5 days ago");
    expect(relativeTime(new Date("2026-10-20T12:00:00Z"), now)).toBe("3 weeks ago");
    expect(relativeTime(new Date("2025-11-01T12:00:00Z"), now)).toBe("1 year ago");
  });
  test("formatTimestamp adds a local date and passes invalid input through", () => {
    expect(formatTimestamp("2026-11-10T09:00:00Z", now)).toMatch(/^3 hours ago \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}( \S+)?\)$/);
    expect(formatTimestamp("garbage", now)).toBe("garbage");
  });
});

describe("sync README", () => {
  test("repoOwner reads the owner and ignores credentials and local paths", () => {
    expect(repoOwner("git@github.com:me/skills.git")).toBe("me");
    expect(repoOwner("https://token@github.com/me/skills")).toBe("me");
    expect(repoOwner("ssh://git@gitlab.example.com:2222/team/skills.git")).toBe("team");
    expect(repoOwner("https://git.example.com/skills.git")).toBeNull();
    expect(repoOwner("file:///home/me/skills.git")).toBeNull();
    expect(repoOwner("/home/me/skills.git")).toBeNull();
    expect(repoOwner("C:\\Users\\me\\skills.git")).toBeNull();
    expect(repoOwner("git@github.com:IanWijma/skills.git")).toBe("IanWijma");
  });

  test("the README never carries credentials from the clone URL", () => {
    expect(shareableUrl("https://user:TOKEN@github.com/me/skills.git")).toBe("https://github.com/me/skills.git");
    expect(shareableUrl("https://TOKEN@github.com/me/skills.git?private_token=x")).toBe("https://github.com/me/skills.git");
    expect(shareableUrl("ssh://git:pw@git.example.com:2222/me/skills.git")).toBe("ssh://git@git.example.com:2222/me/skills.git");
    expect(shareableUrl("git@github.com:me/skills.git")).toBe("git@github.com:me/skills.git");
    expect(shareableUrl("https://github.com/me/skills.git")).toBe("https://github.com/me/skills.git");
    const readme = newReadme("https://user:TOKEN@github.com/me/skills.git");
    expect(readme).not.toContain("TOKEN");
    expect(readme).toContain("sync init https://github.com/me/skills.git");
    expect(readme).toMatch(/^# <a .*<\/a> me's Skills\n/);
    expect(readme).not.toContain("{{");
  });

  test("readmeTitle names the repo owner, else the git user, else nobody", () => {
    expect(readmeTitle("https://github.com/ianwijma/skills.git")).toBe("ianwijma's Skills");
    expect(readmeTitle("ssh://git@git.example.com:2222/team/skills.git")).toBe("team's Skills");
    expect(readmeTitle("file:///home/me/skills.git", "Ian")).toBe("Ian's Skills");
    expect(readmeTitle("file:///home/me/skills.git", "")).toBe("My Skills");
    expect(readmeTitle("https://git.example.com/skills.git")).toBe("My Skills");
  });

});

describe("newerRelease", () => {
  test("stable installs only move to latest; prereleases also consider next", () => {
    expect(newerRelease("0.2.0", { latest: "0.3.0", next: "0.4.0-rc.0" })).toBe("0.3.0");
    expect(newerRelease("0.3.0", { latest: "0.3.0", next: "0.4.0-rc.0" })).toBeNull();
    expect(newerRelease("0.2.0-rc.0", { latest: "0.1.0", next: "0.2.0-rc.1" })).toBe("0.2.0-rc.1");
    expect(newerRelease("0.2.0-rc.0", { latest: "0.2.0", next: "0.2.0-rc.1" })).toBe("0.2.0");
    expect(newerRelease("0.2.0-rc.1", { latest: "0.1.0", next: "0.2.0-rc.1" })).toBeNull();
    expect(newerRelease("0.2.0", { latest: 42, next: "garbage" })).toBeNull();
  });

  test("a stable install never moves to a prerelease, even one tagged latest", () => {
    expect(newerRelease("0.2.0", { latest: "0.3.0-rc.0" })).toBeNull();
    expect(newerRelease("0.2.0", { latest: "0.3.0-rc.0", next: "0.3.0-rc.1" })).toBeNull();
    expect(newerRelease("0.2.0", { latest: "1.0.0-beta.1", next: "0.2.1" })).toBeNull();
    expect(newerRelease("0.2.0-rc.0", { latest: "0.3.0-rc.0" })).toBe("0.3.0-rc.0");
  });
});
