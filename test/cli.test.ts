import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { git, gitRepo, project, readJson, run, sandbox, skillMd, writeFiles } from "./helpers.ts";

describe("root commands", () => {
  test("--version is bare; no args prints the banner and exits 0", async () => {
    const sb = await sandbox();
    const v = await run(sb, ["--version"]);
    expect(v.stdout).toBe("0.1.0\n");
    expect((await run(sb, ["-v"])).stdout).toBe("0.1.0\n");
    const none = await run(sb, []);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("skill-library add");
  });

  test("help short-circuits; remove has its own help", async () => {
    const sb = await sandbox();
    const h = await run(sb, ["add", "--help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("Usage:");
    expect(h.stdout).toContain("Add-ons:");
    expect((await run(sb, ["rm", "-h"])).stdout).toContain("skill-library remove [skills...]");
  });

  test("unknown command on stdout, exit 1; sync is dropped", async () => {
    const sb = await sandbox();
    const r = await run(sb, ["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("Unknown command: frobnicate\nRun skill-library --help for usage.\n");
    expect((await run(sb, ["sync"])).code).toBe(1);
  });

  test("old command forms are refused and change nothing", async () => {
    const sb = await sandbox();
    const a = await run(sb, ["add", "--name", "x", "--description", "y", "--path", "/tmp/x"]);
    expect(a.code).toBe(1);
    expect(a.stderr).toContain("old command form");
    expect(a.stderr).toContain("Run skill-library add <any source> once to install the new gateway.");
    expect((await run(sb, ["get", "abcd1234"])).code).toBe(1);
    expect((await run(sb, ["update", "abcd1234", "--description", "z"])).code).toBe(1);
    await expect(fsp.access(sb.store)).rejects.toThrow();
  });

  test("init writes the vercel template", async () => {
    const sb = await sandbox();
    const r = await run(sb, ["init", "my-skill"]);
    expect(r.code).toBe(0);
    const md = await fsp.readFile(path.join(sb.root, "my-skill", "SKILL.md"), "utf8");
    expect(md).toContain("name: my-skill");
    expect((await run(sb, ["init", "my-skill"])).stdout).toContain("Skill already exists at");
  });
});

describe("local sources", () => {
  test("project add: in-repo folder read in place, outside folder stored with hash", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(dir, { "skills/foo/SKILL.md": skillMd("foo", "Foo") });
    await writeFiles(path.join(sb.home, "my-skills"), { "bar/SKILL.md": skillMd("bar", "Bar"), "baz/SKILL.md": skillMd("baz", "Baz") });
    expect((await run(sb, ["add", "./skills/foo", "-y"], { cwd: dir })).code).toBe(0);
    const r = await run(sb, ["add", path.join(sb.home, "my-skills"), "-y", "-a", "claude-code"], { cwd: dir });
    expect(r.code).toBe(0);
    const m = await readJson(path.join(dir, "skill-library.json"));
    expect(Object.keys(m.skills)).toEqual(["home://my-skills/bar", "home://my-skills/baz", "local://skills/foo"]);
    expect(m.skills["local://skills/foo"]).toEqual({ agents: "all" });
    expect(m.skills["home://my-skills/bar"]).toEqual({ source: "~/my-skills/bar", hash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/), agents: ["claude-code"] });
    const index = await readJson(path.join(sb.store, "index.json"));
    expect(index.version).toBe(2);
    expect(index.skills.map((s: any) => [s.id, s.global])).toEqual([
      ["home://my-skills/bar", false],
      ["home://my-skills/baz", false],
    ]);
  });

  test("list --json shape and statuses; global add flips global, agents union", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(path.join(sb.home, "s"), { "bar/SKILL.md": skillMd("bar", "Bar") });
    await run(sb, ["add", "~/s/bar".replace("~", sb.home), "-y", "-a", "codex"], { cwd: dir });
    let rows = JSON.parse((await run(sb, ["list", "-g", "--json"], { cwd: dir })).stdout);
    expect(rows[0]).toMatchObject({ name: "bar", scope: "global", status: "untracked", agents: [] });
    await run(sb, ["add", path.join(sb.home, "s", "bar"), "-g", "-y", "-a", "codex"], { cwd: dir });
    await run(sb, ["add", path.join(sb.home, "s", "bar"), "-g", "-y", "-a", "claude-code"], { cwd: dir });
    rows = JSON.parse((await run(sb, ["list", "-g", "--json"], { cwd: dir })).stdout);
    expect(rows[0]).toMatchObject({ status: "tracked", agents: ["Codex", "Claude Code"], sourceType: "local", sourceUrl: null });
    expect(Object.keys(rows[0]).sort()).toEqual(["agents", "id", "name", "path", "scope", "source", "sourceType", "sourceUrl", "status"]);
    const proj = JSON.parse((await run(sb, ["ls", "--json"], { cwd: dir })).stdout);
    expect(proj[0]).toMatchObject({ scope: "project", status: "tracked", agents: ["Codex"] });
    expect(JSON.parse((await run(sb, ["ls", "--json", "-a", "claude-code"], { cwd: dir })).stdout)).toEqual([]);
  });

  test("remove: project drops the reference (stays in store, not global); -g deletes; agent rules", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(path.join(sb.root, "src"), { "bar/SKILL.md": skillMd("bar", "Bar"), "qux/SKILL.md": skillMd("qux", "Qux") });
    await run(sb, ["add", path.join(sb.root, "src"), "-y", "-a", "codex", "claude-code"], { cwd: dir });
    let r = await run(sb, ["remove", "bar", "-a", "codex", "-y"], { cwd: dir });
    expect(r.code).toBe(0);
    let m = await readJson(path.join(dir, "skill-library.json"));
    expect(Object.values(m.skills).map((e: any) => e.agents)).toEqual([["claude-code"], ["codex", "claude-code"]]);
    r = await run(sb, ["remove", "bar", "-y"], { cwd: dir });
    expect(r.stdout).toContain("Successfully removed 1 skill(s)");
    m = await readJson(path.join(dir, "skill-library.json"));
    expect(Object.keys(m.skills)).toHaveLength(1);
    const listed = JSON.parse((await run(sb, ["ls", "-g", "--json"], { cwd: dir })).stdout);
    expect(listed.find((x: any) => x.name === "bar").status).toBe("untracked");
    const none = await run(sb, ["remove", "nope", "-y"], { cwd: dir });
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("No matching skills found for: nope");
    const g = await run(sb, ["remove", "-g", "qux", "-y"], { cwd: dir });
    expect(g.stderr).toContain("still referenced by");
    expect((await readJson(path.join(sb.store, "index.json"))).skills.map((s: any) => s.id)).not.toContainEqual(expect.stringContaining("qux"));
    const all = await run(sb, ["remove", "--all", "bar"], { cwd: dir });
    expect(all.code).toBe(1);
    expect(all.stderr).toContain("Cannot combine --all with specific skill names.");
  });

  test("remove -a on an all-agents skill explains instead of exploding the list", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(path.join(sb.root, "src"), { "bar/SKILL.md": skillMd("bar", "Bar") });
    await run(sb, ["add", path.join(sb.root, "src", "bar"), "-y"], { cwd: dir });
    const r = await run(sb, ["remove", "bar", "-a", "codex", "-y"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("bar is available to all agents; remove it without -a");
    expect((await readJson(path.join(dir, "skill-library.json"))).skills).not.toEqual({});
  });

  test("$HOME without a manifest behaves as -g", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.home, "s"), { "bar/SKILL.md": skillMd("bar", "Bar") });
    const r = await run(sb, ["add", "./s/bar", "-y"], { cwd: sb.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("No project here; using global scope.");
    expect((await readJson(path.join(sb.store, "index.json"))).skills[0].global).toBe(true);
  });

  test("non-TTY without -y and several skills fails; inside an agent -y is implied", async () => {
    const sb = await sandbox();
    const dir = await project(sb);
    await writeFiles(path.join(sb.root, "src"), { "a/SKILL.md": skillMd("a", "A"), "b/SKILL.md": skillMd("b", "B") });
    const r = await run(sb, ["add", path.join(sb.root, "src")], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a TTY");
    const inAgent = await run(sb, ["add", path.join(sb.root, "src")], { cwd: dir, env: { CLAUDECODE: "1" } });
    expect(inAgent.code).toBe(0);
    const m = await readJson(path.join(dir, "skill-library.json"));
    expect(Object.values(m.skills).every((e: any) => e.agents === "all")).toBe(true);
  });

  test("add --json: one JSON value on stdout even with notices; needs -y; rejects -l", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.home, "s"), { "bar/SKILL.md": skillMd("bar", "Bar") });
    const r = await run(sb, ["add", "./s/bar", "--json", "-y"], { cwd: sb.home, env: { SKILL_LIBRARY_NO_GATEWAY: undefined } });
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout);
    expect(rows[0]).toMatchObject({ name: "bar", status: "installed", scope: "global" });
    expect(r.stderr).toContain("No project here");
    const noYes = await run(sb, ["add", "./s/bar", "--json"], { cwd: sb.home });
    expect(noYes.code).toBe(1);
    expect(noYes.stdout).toBe("[]\n");
    expect((await run(sb, ["add", "./s/bar", "--json", "-y", "-l"], { cwd: sb.home })).stdout).toBe("[]\n");
  });

  test("invalid agents use vercel's diagnostic", async () => {
    const sb = await sandbox();
    const r = await run(sb, ["add", "./x", "-a", "nope", "-y"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Invalid agents: nope");
    expect(r.stderr).toContain("Valid agents: ");
  });
});

describe("git sources", () => {
  test("add pins commit and hash; install on a fresh machine fetches the pinned commit", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "skills", { "skills/react/SKILL.md": skillMd("react", "React rules"), "skills/vue/SKILL.md": skillMd("vue", "Vue rules") });
    const dir = await project(sb);
    const r = await run(sb, ["add", repo.url, "-s", "react", "-y"], { cwd: dir });
    expect(r.code).toBe(0);
    const id = `repo://localhost${repo.bare.replace(/\.git$/, "")}/react`;
    const m = await readJson(path.join(dir, "skill-library.json"));
    expect(m.skills[id]).toEqual({ source: repo.url, ref: null, path: "skills/react", commit: repo.head, hash: expect.stringMatching(/^sha256-/), agents: "all" });

    // Upstream moves on; a fresh store still installs exactly the pinned version.
    await repo.commit({ "skills/react/SKILL.md": skillMd("react", "React rules v2") });
    const fresh = { ...sb, env: { ...sb.env, SKILL_LIBRARY_DIR: path.join(sb.root, "store2") } };
    const inst = await run(fresh, ["install"], { cwd: dir });
    expect(inst.code).toBe(0);
    expect(inst.stdout).toContain(`Installed ${id}`);
    const rows = JSON.parse((await run(fresh, ["ls", "--json"], { cwd: dir })).stdout);
    const md = await fsp.readFile(path.join(rows[0].path, "SKILL.md"), "utf8");
    expect(md).toContain("React rules\n");
    expect(path.basename(rows[0].path)).toBe(repo.head.slice(0, 12));
    expect((await run(fresh, ["install"], { cwd: dir })).stdout).toContain("already installed");
  });

  test("install refuses content that does not match the pinned hash", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "SKILL.md": skillMd("solo", "Solo") });
    const dir = await project(sb);
    await run(sb, ["add", repo.url, "-y"], { cwd: dir });
    const file = path.join(dir, "skill-library.json");
    const m = await readJson(file);
    const id = Object.keys(m.skills)[0]!;
    m.skills[id].hash = "sha256-" + "0".repeat(64);
    await fsp.writeFile(file, JSON.stringify(m));
    const fresh = { ...sb, env: { ...sb.env, SKILL_LIBRARY_DIR: path.join(sb.root, "store2") } };
    const r = await run(fresh, ["install"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("refusing to install");
    await expect(fsp.access(path.join(sb.root, "store2", "index.json"))).rejects.toThrow();
  });

  test("fetch-by-commit falls back to a full clone when the server refuses it", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "nosha", { "SKILL.md": skillMd("solo", "Solo") }, { allowSha: false });
    const dir = await project(sb);
    await run(sb, ["add", repo.url, "-y"], { cwd: dir });
    const fresh = { ...sb, env: { ...sb.env, SKILL_LIBRARY_DIR: path.join(sb.root, "store2") } };
    expect((await run(fresh, ["install"], { cwd: dir })).code).toBe(0);
  });

  test("install --force repairs a corrupted version folder; pins unchanged", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "SKILL.md": skillMd("solo", "Solo") });
    const dir = await project(sb);
    await run(sb, ["add", repo.url, "-y"], { cwd: dir });
    const before = await fsp.readFile(path.join(dir, "skill-library.json"), "utf8");
    const rows = JSON.parse((await run(sb, ["ls", "--json"], { cwd: dir })).stdout);
    await fsp.writeFile(path.join(rows[0].path, "SKILL.md"), "tampered");
    const plain = await run(sb, ["install"], { cwd: dir });
    expect(plain.stdout).toContain("already installed");
    const forced = await run(sb, ["install", "--force"], { cwd: dir });
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("Repaired");
    expect(await fsp.readFile(path.join(rows[0].path, "SKILL.md"), "utf8")).toContain("Solo");
    expect(await fsp.readFile(path.join(dir, "skill-library.json"), "utf8")).toBe(before);
  });

  test("two projects pin different versions side by side; update moves only this project's pin", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "skills/a/SKILL.md": skillMd("a", "A v1"), "skills/b/SKILL.md": skillMd("b", "B v1") });
    const p1 = await project(sb, "p1");
    const p2 = await project(sb, "p2");
    await run(sb, ["add", repo.url, "-s", "a", "-y"], { cwd: p1 });
    // A commit that only touches another skill is not an update for `a`.
    await repo.commit({ "skills/b/SKILL.md": skillMd("b", "B v2") });
    const chk = await run(sb, ["check"], { cwd: p1 });
    expect(chk.code).toBe(0);
    expect(chk.stdout).toContain("a is up to date");
    const v2 = await repo.commit({ "skills/a/SKILL.md": skillMd("a", "A v2") });
    await run(sb, ["add", repo.url, "-s", "a", "-y"], { cwd: p2 });
    const pin = async (p: string) => Object.values((await readJson(path.join(p, "skill-library.json"))).skills)[0] as any;
    expect((await pin(p1)).commit).toBe(repo.head);
    expect((await pin(p2)).commit).toBe(v2);
    const c1 = await run(sb, ["check"], { cwd: p1 });
    expect(c1.code).toBe(1);
    expect(c1.stdout).toContain("a has an update");
    const u = await run(sb, ["update", "-y"], { cwd: p1 });
    expect(u.code).toBe(0);
    expect((await pin(p1)).commit).toBe(v2);
    const index = await readJson(path.join(sb.store, "index.json"));
    expect(Object.keys(index.skills[0].versions)).toEqual([repo.head.slice(0, 12), v2.slice(0, 12)]);
    expect(index.skills[0].global).toBe(false);
  });

  test("per-version descriptions: a project pinned to the old version is scored on it", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "r", { "SKILL.md": skillMd("solo", "Old description") });
    const p1 = await project(sb, "p1");
    await run(sb, ["add", repo.url, "-y"], { cwd: p1 });
    await repo.commit({ "SKILL.md": skillMd("solo", "New description") });
    await run(sb, ["add", repo.url, "-g", "-y"], { cwd: p1 });
    const proj = JSON.parse((await run(sb, ["ls", "--json"], { cwd: p1 })).stdout);
    const glob = JSON.parse((await run(sb, ["ls", "-g", "--json"], { cwd: p1 })).stdout);
    expect(await fsp.readFile(path.join(proj[0].path, "SKILL.md"), "utf8")).toContain("Old description");
    expect(await fsp.readFile(path.join(glob[0].path, "SKILL.md"), "utf8")).toContain("New description");
    const index = await readJson(path.join(sb.store, "index.json"));
    expect(Object.values(index.skills[0].versions).map((v: any) => v.description)).toEqual(["Old description", "New description"]);
  });

  test("duplicate skill names in one source are refused", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "dupes", { "skills/x/SKILL.md": skillMd("same", "one"), "skills/y/SKILL.md": skillMd("same", "two") });
    const r = await run(sb, ["add", repo.url, "-y", "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Several folders declare the same skill name");
  });

  test("this repository's gateway source stores nothing and places the gateway", async () => {
    const sb = await sandbox();
    const repo = await gitRepo(sb, "gw", { "skills/skill-library/SKILL.md": skillMd("skill-library", "gateway") });
    await fsp.mkdir(path.join(sb.home, ".claude"), { recursive: true });
    const r = await run(sb, ["add", repo.url, "-g", "-y"], { env: { SKILL_LIBRARY_NO_GATEWAY: undefined } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("only contains the skill-library gateway");
    await expect(fsp.access(path.join(sb.store, "index.json"))).rejects.toThrow();
    const placed = await fsp.readFile(path.join(sb.home, ".claude", "skills", "skill-library", "SKILL.md"), "utf8");
    expect(placed).toContain("skill-library query -a <your-agent-id>");
  });
});

describe("gateway placement", () => {
  test("only add writes agent folders; symlinked old install and helpers are replaced", async () => {
    const sb = await sandbox();
    const env = { SKILL_LIBRARY_NO_GATEWAY: undefined };
    await fsp.mkdir(path.join(sb.home, ".claude"), { recursive: true });
    await fsp.mkdir(path.join(sb.home, ".codex"), { recursive: true });
    // Old vercel install: canonical copy + symlinks from the agent dirs.
    const canonical = path.join(sb.home, ".agents", "skills");
    await writeFiles(canonical, {
      "skill-library/SKILL.md": skillMd("skill-library", "old gateway"),
      "skill-library-get/SKILL.md": skillMd("skill-library-get", "old helper"),
    });
    await fsp.mkdir(path.join(sb.home, ".claude", "skills"), { recursive: true });
    await fsp.symlink(path.join(canonical, "skill-library"), path.join(sb.home, ".claude", "skills", "skill-library"));
    await fsp.symlink(path.join(canonical, "skill-library-get"), path.join(sb.home, ".claude", "skills", "skill-library-get"));
    await writeFiles(path.join(sb.root, "s"), { "bar/SKILL.md": skillMd("bar", "Bar") });

    await run(sb, ["list", "-g"], { env });
    expect((await fsp.lstat(path.join(sb.home, ".claude", "skills", "skill-library"))).isSymbolicLink()).toBe(true);

    const r = await run(sb, ["add", path.join(sb.root, "s", "bar"), "-g", "-y"], { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Updated skill-library gateway for");
    const claudeGw = path.join(sb.home, ".claude", "skills", "skill-library");
    expect((await fsp.lstat(claudeGw)).isDirectory()).toBe(true);
    const a = await fsp.readFile(path.join(claudeGw, "SKILL.md"), "utf8");
    const b = await fsp.readFile(path.join(canonical, "skill-library", "SKILL.md"), "utf8");
    expect(a).toBe(b);
    expect(a).toContain("skill-library query -a <your-agent-id>");
    await expect(fsp.lstat(path.join(sb.home, ".claude", "skills", "skill-library-get"))).rejects.toThrow();
    await expect(fsp.access(path.join(canonical, "skill-library-get"))).rejects.toThrow();
    // Idempotent: a second add writes nothing.
    const again = await run(sb, ["add", path.join(sb.root, "s", "bar"), "-g", "-y"], { env });
    expect(again.stderr).not.toContain("Updated skill-library gateway");
  });

  test("a read-only agent dir never fails the add", async () => {
    const sb = await sandbox();
    await fsp.mkdir(path.join(sb.home, ".claude", "skills"), { recursive: true });
    await fsp.chmod(path.join(sb.home, ".claude", "skills"), 0o500);
    await writeFiles(path.join(sb.root, "s"), { "bar/SKILL.md": skillMd("bar", "Bar") });
    const r = await run(sb, ["add", path.join(sb.root, "s", "bar"), "-g", "-y"], { env: { SKILL_LIBRARY_NO_GATEWAY: undefined } });
    await fsp.chmod(path.join(sb.home, ".claude", "skills"), 0o700);
    expect(r.code).toBe(0);
  });
});

describe("migration v1 → v2", () => {
  async function v1Store(sb: Awaited<ReturnType<typeof sandbox>>) {
    const s = sb.store;
    await writeFiles(s, {
      "skills/aaaa1111/SKILL.md": "# no frontmatter\n",
      "skills/bbbb2222/SKILL.md": skillMd("helper", "x"),
      "skills/cccc3333/SKILL.md": skillMd("skill-library-get", "old helper"),
    });
    const index = [
      { id: "aaaa1111", name: "notes", description: "Hand-written description", source: path.join(sb.home, "gone", "notes.md"), addedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", contentDir: "skills/aaaa1111" },
      { id: "bbbb2222", name: "helper", description: "Helper", source: "/opt/elsewhere/helper", addedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", contentDir: "skills/bbbb2222" },
      { id: "cccc3333", name: "skill-library-get", description: "old", source: "", addedAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", contentDir: "skills/cccc3333" },
    ];
    await fsp.writeFile(path.join(s, "index.json"), JSON.stringify(index));
    return index;
  }

  test("migrates ids, keeps names/descriptions, drops helpers, removes old folders", async () => {
    const sb = await sandbox();
    await v1Store(sb);
    const r = await run(sb, ["ls", "-g", "--json"], { cwd: sb.home });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Migrated 2 skills to the new store format.");
    expect(r.stderr).toContain("skill-library-get");
    const rows = JSON.parse(r.stdout);
    expect(rows.map((x: any) => [x.name, x.id])).toEqual([
      ["helper", "path:///opt/elsewhere/helper"],
      ["notes", "home://gone/notes.md"],
    ]);
    const index = await readJson(path.join(sb.store, "index.json"));
    const notes = index.skills.find((s: any) => s.name === undefined && s.id === "home://gone/notes.md");
    expect(notes.source.type).toBe("file");
    expect(Object.values(notes.versions)[0]).toMatchObject({ name: "notes", description: "Hand-written description" });
    await fsp.access(path.join(sb.store, "index.v1.json"));
    await expect(fsp.access(path.join(sb.store, "skills", "aaaa1111"))).rejects.toThrow();
  });

  test("a failure midway leaves the v1 store intact", async () => {
    const sb = await sandbox();
    const v1 = await v1Store(sb);
    await fsp.chmod(path.join(sb.store, "skills", "bbbb2222"), 0o000);
    const r = await run(sb, ["ls", "-g"], { cwd: sb.home });
    await fsp.chmod(path.join(sb.store, "skills", "bbbb2222"), 0o700);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the old store is untouched");
    expect(await readJson(path.join(sb.store, "index.json"))).toEqual(v1);
    await fsp.access(path.join(sb.store, "skills", "aaaa1111", "SKILL.md"));
  });
});

describe("use", () => {
  test("prints the prompt without -a; launches the agent with -a and passes its exit code", async () => {
    const sb = await sandbox();
    await writeFiles(path.join(sb.root, "src"), { "a/SKILL.md": skillMd("a", "A"), "b/SKILL.md": skillMd("b", "B"), "b/ref.md": "extra" });
    const many = await run(sb, ["use", path.join(sb.root, "src")]);
    expect(many.code).toBe(1);
    expect(many.stderr).toContain("This source contains multiple skills");
    const r = await run(sb, ["use", path.join(sb.root, "src"), "-s", "a"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("You are being given a Skill to execute");
    expect(r.stdout).toContain("<SKILL.md>");
    const withFiles = await run(sb, ["use", path.join(sb.root, "src"), "--skill", "b"]);
    expect(withFiles.stdout).toContain("Supporting files for this skill were downloaded to:");
    const bin = path.join(sb.root, "bin");
    await writeFiles(bin, { claude: '#!/bin/sh\necho "launched:$#"\nexit 7\n' });
    await fsp.chmod(path.join(bin, "claude"), 0o755);
    const launched = await run(sb, ["use", path.join(sb.root, "src"), "-s", "a", "-a", "claude-code"], { env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(launched.code).toBe(7);
    expect(launched.stdout).toContain("launched:1");
    const conflict = await run(sb, ["use", `${path.join(sb.root, "src")}`, "-s", "a", "--bogus"]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain("Unknown option: --bogus");
    expect((await run(sb, ["use", "./x", "-a", "cursor"])).stderr).toContain("is not supported yet");
  });
});

describe("find", () => {
  test("searches SKILLS_API_URL and prints results", async () => {
    const sb = await sandbox();
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ skills: [{ id: "o/r/x", slug: "o/r/x", name: "x", source: "o/r", installs: 1234 }], q: req.url }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const r = await run(sb, ["find", "react"], { env: { SKILLS_API_URL: `http://127.0.0.1:${port}` } });
    server.close();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("o/r@x");
    expect(r.stdout).toContain("1.2K installs");
    expect(r.stdout).toContain("└ https://skills.sh/o/r/x");
  });
});

void git;
