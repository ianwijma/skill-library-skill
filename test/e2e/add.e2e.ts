// `add` (aliases a, install <src>, i <src>): every source form and every flag, with the library,
// the project manifest and the gateway validated after each change.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { exists, readJson, skillMd, world, type World } from "./harness.ts";
import { expectJsonOrNothing, expectUnknownOption, expectUsageError } from "./contract.ts";
import { assertAddJson, assertListJson, validateAll, validateGateway, validateManifest, validateStore, type StoreRecord } from "./validate.ts";

const GH = "repo://github.com";

async function record(w: World, id: string): Promise<StoreRecord> {
  const index = await validateStore(w);
  const r = index.skills.find((s) => s.id === id);
  if (!r) throw new Error(`${id} not in the library: ${index.skills.map((s) => s.id).join(", ")}`);
  return r;
}

async function ids(w: World): Promise<string[]> {
  return (await validateStore(w)).skills.map((s) => s.id);
}

/** Add with -g -y --json and return the validated rows. */
async function addJson(w: World, args: string[], opts: { cwd?: string } = {}): Promise<any[]> {
  const r = await w.ok(["add", ...args, "-y", "--json"], opts);
  const rows = r.json();
  assertAddJson(rows);
  return rows;
}

describe("add: local sources", () => {
  test("folder with one skill (path://), single .md file, folder under HOME (home://)", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), {
      "solo/SKILL.md": skillMd("solo", "One skill", "", ""),
      "solo/ref/notes.md": "supporting file",
      "loose.md": skillMd("loose", "A markdown file"),
    });
    const solo = path.join(src, "solo");
    const r = await w.ok(["add", solo, "-g", "-y"]);
    expect(r.stdout).toContain("Installation Summary → global library");
    expect(r.stdout).toContain(`Stored solo (path://${solo})`);
    expect(r.stdout).toContain("agents: all agents");
    const rec = await record(w, `path://${solo}`);
    expect(rec.global).toBe(true);
    expect(rec.agents).toBe("all");
    expect(rec.source).toEqual({ type: "folder", url: solo, ref: null, path: "" });
    expect(Object.keys(rec.versions)).toHaveLength(1);
    expect(rec.current).toMatch(/^h-[0-9a-f]{12}$/);
    expect(await fsp.readFile(path.join(w.store, rec.dir, rec.current, "ref", "notes.md"), "utf8")).toBe("supporting file");

    await w.ok(["add", path.join(src, "loose.md"), "-g", "-y"]);
    const file = await record(w, `path://${path.join(src, "loose.md")}`);
    expect(file.source.type).toBe("file");
    expect(await fsp.readdir(path.join(w.store, file.dir, file.current))).toEqual(["SKILL.md"]);

    const mine = await w.write(path.join(w.home, "my-skills"), { "own/SKILL.md": skillMd("own", "Under home") });
    await w.ok(["add", path.join(mine, "own"), "-g", "-y"]);
    await record(w, "home://my-skills/own");
    // Relative paths resolve against the working directory.
    await w.write(path.join(w.home, "rel"), { "relskill/SKILL.md": skillMd("relskill", "Relative") });
    await w.ok(["add", "./relskill", "-g", "-y"], { cwd: path.join(w.home, "rel") });
    await record(w, "home://rel/relskill");
    await validateAll(w);
    expect((await w.ok(["list", "-g", "--json"])).json().map((x: any) => x.name).sort()).toEqual(["loose", "own", "relskill", "solo"]);
  });

  test("folder with many skills: -s one, several, '*', no match, full id; repo-root SKILL.md wins; --full-depth finds nested ones", async () => {
    const w = await world();
    const many = await w.write(await w.dir("many"), {
      "skills/alpha/SKILL.md": skillMd("alpha", "Alpha"),
      "skills/beta/SKILL.md": skillMd("beta", "Beta"),
      "skills/gamma/SKILL.md": skillMd("gamma", "Gamma"),
    });
    const id = (n: string) => `path://${path.join(many, "skills", n)}`;
    // Without -s and without a TTY, several skills need a selection.
    const noTty = await w.run(["add", many, "-g"]);
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain("Interactive prompt required but stdin is not a TTY");
    expect(await exists(path.join(w.store, "index.json"))).toBe(false);

    await w.ok(["add", many, "-g", "-y", "-s", "alpha"]);
    expect(await ids(w)).toEqual([id("alpha")]);
    await w.ok(["add", many, "-g", "-y", "--skill", "beta", "gamma"]);
    expect(await ids(w)).toEqual([id("alpha"), id("beta"), id("gamma")].sort());
    const none = await w.run(["add", many, "-g", "-y", "-s", "delta"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No matching skills found for: delta");
    expect(none.stderr).toContain("Available skills:\n  - alpha\n  - beta\n  - gamma");
    // A full id works as a selector; '*' takes everything; -y alone takes everything too.
    const w2 = await world();
    const m2 = await w2.write(await w2.dir("many"), { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha"), "skills/beta/SKILL.md": skillMd("beta", "Beta") });
    await w2.ok(["add", m2, "-g", "-y", "-s", `path://${path.join(m2, "skills", "beta")}`]);
    expect(await ids(w2)).toEqual([`path://${path.join(m2, "skills", "beta")}`]);
    await w2.ok(["add", m2, "-g", "-y", "-s", "*"]);
    expect((await ids(w2)).length).toBe(2);
    await validateAll(w);
    await validateAll(w2);

    // A SKILL.md at the root is the skill (nested ones ignored) unless --full-depth.
    const nested = await w.write(await w.dir("nested"), {
      "SKILL.md": skillMd("root-skill", "At the root"),
      "deep/a/b/c/inner/SKILL.md": skillMd("inner", "Deep inside"),
    });
    const listed = await w.ok(["add", nested, "-l"]);
    expect(listed.stdout).toContain("root-skill");
    expect(listed.stdout).not.toContain("inner");
    const deep = await w.ok(["add", nested, "-l", "--full-depth"]);
    expect(deep.stdout).toContain("root-skill");
    expect(deep.stdout).toContain("inner");
    await w.ok(["add", nested, "-g", "-y", "--full-depth", "-s", "inner"]);
    await record(w, `path://${path.join(nested, "deep/a/b/c/inner")}`);
    await validateAll(w);
  });

  test("invalid frontmatter is skipped with a warning; metadata.internal is hidden unless INSTALL_INTERNAL_SKILLS=1; duplicate names are refused", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), {
      "skills/good/SKILL.md": skillMd("good", "Good"),
      "skills/noname/SKILL.md": "---\ndescription: no name\n---\nbody\n",
      "skills/broken/SKILL.md": "---\nname: [unclosed\n---\n",
      "skills/secret/SKILL.md": skillMd("secret", "Internal", "", "metadata:\n  internal: true\n"),
    });
    const r = await w.ok(["add", src, "-g", "-y"]);
    expect(r.stderr).toContain("missing required frontmatter field(s): name, description");
    expect(r.stderr).toContain("YAML parse error");
    expect(await ids(w)).toEqual([`path://${path.join(src, "skills", "good")}`]);
    await w.ok(["add", src, "-g", "-y", "-s", "secret"], { env: { INSTALL_INTERNAL_SKILLS: "1" } });
    expect((await ids(w)).length).toBe(2);
    await validateAll(w);

    const dup = await w.write(await w.dir("dup"), { "one/SKILL.md": skillMd("same", "First"), "two/SKILL.md": skillMd("same", "Second") });
    const d = await w.run(["add", dup, "-g", "-y"]);
    expect(d.code).toBe(1);
    expect(d.stderr).toContain("Several folders declare the same skill name");
    const empty = await w.write(await w.dir("empty"), { "README.md": "nothing here" });
    const e = await w.run(["add", empty, "-g", "-y"]);
    expect(e.code).toBe(1);
    expect(e.stderr).toContain("No valid skills found");
    const missing = await w.run(["add", path.join(w.root, "nope"), "-g", "-y"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`Local path does not exist: ${path.join(w.root, "nope")}`);
    expect((await ids(w)).length).toBe(2);
    await validateAll(w);
  });

  test("the gateway source (and reserved-name files) store nothing and place the gateway", async () => {
    const w = await world();
    await w.dir("home/.claude");
    const src = await w.write(await w.dir("src"), {
      "gw/skills/skill-library/SKILL.md": skillMd("skill-library", "The gateway"),
      "helper.md": skillMd("skill-library-helper", "Reserved namespace"),
    });
    // Without -y and without a TTY nothing is placed.
    const noYes = await w.run(["add", path.join(src, "gw"), "-g"]);
    expect(noYes.code).toBe(1);
    expect(await exists(path.join(w.home, ".claude", "skills", "skill-library"))).toBe(false);
    const r = await w.ok(["add", path.join(src, "gw"), "-g", "-y"]);
    expect(r.stdout).toContain("This source only contains the skill-library gateway; nothing was added to the library.");
    await validateGateway([path.join(w.home, ".claude", "skills")]);
    const h = await w.ok(["add", path.join(src, "helper.md"), "-g", "-y"]);
    expect(h.stdout).toContain("only contains the skill-library gateway");
    const l = await w.ok(["add", path.join(src, "gw"), "--list"]);
    expect(l.stdout).toContain("only the skill-library gateway");
    expect(await exists(path.join(w.store, "index.json"))).toBe(false);
  });
});

describe("add: project scope", () => {
  test("-p creates skill-library.json: in-repo folders are local:// (read in place), outside folders and git skills are pinned", async () => {
    const w = await world();
    const proj = await w.write(await w.dir("proj"), { ".skills/house/SKILL.md": skillMd("house", "House rules"), "notes.md": skillMd("notes", "In-project file") });
    const outside = await w.write(await w.dir("outside"), { "ext/SKILL.md": skillMd("ext", "External") });
    const repo = await w.github("acme/tools", { "skills/lint/SKILL.md": skillMd("lint", "Lint rules") });

    const r = await w.ok(["add", "./.skills/house", "-p", "-y"], { cwd: proj });
    expect(r.stdout).toContain(`Installation Summary → project (${proj}/skill-library.json)`);
    expect(r.stdout).toContain("Added house (local://.skills/house)");
    // A local:// skill is read in place: nothing is stored.
    expect(await exists(path.join(w.store, "index.json"))).toBe(false);
    await w.ok(["add", path.join(outside, "ext"), "--project", "-y"], { cwd: proj });
    await w.ok(["add", "acme/tools", "-p", "-y", "-a", "claude-code"], { cwd: proj });
    const m = await validateManifest(w, proj);
    expect(Object.keys(m.skills)).toEqual(["local://.skills/house", `path://${path.join(outside, "ext")}`, `${GH}/acme/tools/lint`]);
    expect(m.skills["local://.skills/house"]).toEqual({ name: "house", agents: "all" });
    const lint = m.skills[`${GH}/acme/tools/lint`]!;
    expect(lint).toMatchObject({ name: "lint", source: "https://github.com/acme/tools.git", ref: null, path: "skills/lint", commit: repo.head, agents: ["claude-code"] });
    expect(m.skills[`path://${path.join(outside, "ext")}`]).toMatchObject({ name: "ext", source: path.join(outside, "ext"), agents: "all" });
    // Project adds are not global.
    const index = await validateAll(w, [proj]);
    expect(index.skills.every((s) => !s.global)).toBe(true);
    const rows = (await w.ok(["list", "--json"], { cwd: proj })).json();
    assertListJson(rows);
    expect(rows.map((x: any) => [x.name, x.scope, x.status])).toEqual([
      ["ext", "project", "tracked"],
      ["house", "project", "tracked"],
      ["lint", "project", "tracked"],
    ]);
    // A single markdown file inside the project can't be read in place.
    const md = await w.run(["add", "./notes.md", "-p", "-y"], { cwd: proj });
    expect(md.code).toBe(1);
    expect(md.stderr).toContain("A single markdown file inside the project can't be read in place");
    await validateManifest(w, proj);
  });

  test("scope rules: -p -g is an error; with a skill-library.json and no prompt, -p or -g is required; -p never creates a manifest in HOME", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), { "a/SKILL.md": skillMd("a", "A") });
    const proj = await w.dir("proj");
    for (const args of [["-p", "-g"], ["--project", "--global"]]) {
      const r = await w.run(["add", path.join(src, "a"), ...args, "-y"], { cwd: proj });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--global cannot be combined with --project");
    }
    // Without a manifest, add is global and creates none.
    await w.ok(["add", path.join(src, "a"), "-y"], { cwd: proj });
    expect(await exists(path.join(proj, "skill-library.json"))).toBe(false);
    expect((await record(w, `path://${path.join(src, "a")}`)).global).toBe(true);
    await w.ok(["add", path.join(src, "a"), "-p", "-y"], { cwd: proj });
    expect(await exists(path.join(proj, "skill-library.json"))).toBe(true);
    // Now a project exists: -y does not pick the scope.
    for (const env of [{}, { CLAUDECODE: "1" }]) {
      const r = await w.run(["add", path.join(src, "a"), "-y"], { cwd: proj, env });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("This folder has a project");
      expect(r.stderr).toContain("Use -p to pin in the project's skill-library.json, or -g to add to the global library.");
    }
    // Subfolders find the project upward.
    const sub = await w.dir("proj/deep/er");
    await w.ok(["add", path.join(src, "a"), "-g", "-y"], { cwd: sub });
    const home = await w.run(["add", path.join(src, "a"), "-p", "-y"], { cwd: w.home });
    expect(home.code).toBe(1);
    expect(home.stderr).toContain("skill-library.json is not created in your home directory");
    expect(await exists(path.join(w.home, "skill-library.json"))).toBe(false);
    await validateAll(w, [proj]);
  });
});

describe("add: git sources", () => {
  test("file:// repository: pins the commit and tree; same version re-add is idempotent; an upstream change adds a new version", async () => {
    const w = await world();
    const repo = await w.repo("skills", { "skills/react/SKILL.md": skillMd("react", "React rules"), "skills/vue/SKILL.md": skillMd("vue", "Vue rules") });
    const rows = await addJson(w, [repo.url, "-g", "-s", "react"]);
    const id = `repo://localhost${repo.bare.replace(/\.git$/, "")}/react`;
    expect(rows).toEqual([
      expect.objectContaining({ id, name: "react", status: "installed", source: repo.url, ref: null, scope: "global", agents: expect.arrayContaining(["Claude Code", "Codex"]) }),
    ]);
    const rec = await record(w, id);
    expect(rec.source).toEqual({ type: "git", url: repo.url, ref: null, path: "skills/react" });
    expect(rec.current).toBe(repo.head.slice(0, 12));
    expect(rec.versions[rec.current]!.commit).toBe(repo.head);
    expect(rec.versions[rec.current]!.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(rows[0].path).toBe(path.join(w.store, rec.dir, rec.current));

    // Same version again: still one version, nothing staged.
    await w.ok(["add", repo.url, "-g", "-y", "-s", "react"]);
    expect(Object.keys((await record(w, id)).versions)).toEqual([rec.current]);
    expect(await fsp.readdir(path.join(w.store, ".staging")).catch(() => [])).toEqual([]);

    const v2 = await repo.commit({ "skills/react/SKILL.md": skillMd("react", "React rules v2") });
    await w.ok(["add", repo.url, "-g", "-y", "-s", "react"]);
    const after = await record(w, id);
    expect(Object.keys(after.versions).sort()).toEqual([rec.current, v2.slice(0, 12)].sort());
    expect(after.current).toBe(v2.slice(0, 12));
    expect(after.versions[after.current]!.description).toBe("React rules v2");
    await validateAll(w);
  });

  test("GitHub shorthand and URL forms all resolve to the same skill ids", async () => {
    const w = await world();
    const repo = await w.github("acme/skills", {
      "skills/alpha/SKILL.md": skillMd("alpha", "Alpha"),
      "skills/beta/SKILL.md": skillMd("beta", "Beta"),
      "tools/gamma/SKILL.md": skillMd("gamma", "Gamma"),
    });
    const cases: [string[], string[]][] = [
      [["acme/skills", "-s", "alpha"], ["alpha"]],
      [["acme/skills@beta"], ["beta"]],
      [["acme/skills/tools/gamma"], ["gamma"]],
      [["github:acme/skills", "-s", "alpha"], ["alpha"]],
      [["https://github.com/acme/skills", "-s", "beta"], ["beta"]],
      [["https://github.com/acme/skills.git", "-s", "alpha"], ["alpha"]],
      [["https://github.com/acme/skills/tree/main/tools/gamma"], ["gamma"]],
      [["git@github.com:acme/skills.git", "-s", "beta"], ["beta"]],
    ];
    for (const [args, names] of cases) {
      const rows = await addJson(w, [...args, "-g"]);
      expect(rows.map((r) => [r.name, r.status]), args.join(" ")).toEqual(names.map((n) => [n, "installed"]));
      for (const r of rows) expect(r.id).toBe(`${GH}/acme/skills/${r.name}`);
    }
    // Every form converged on three ids, one version each.
    const index = await validateAll(w);
    expect(index.skills.map((s) => s.id)).toEqual([`${GH}/acme/skills/alpha`, `${GH}/acme/skills/beta`, `${GH}/acme/skills/gamma`]);
    for (const s of index.skills) expect(Object.values(s.versions).map((v) => v.commit)).toEqual([repo.head]);
    expect(index.skills.find((s) => s.id.endsWith("gamma"))!.source.path).toBe("tools/gamma");
  });

  test("refs: #branch, #ref@skill, @v1.0.0 tag pin, full commit SHA, /tree/<branch>/", async () => {
    const w = await world();
    const repo = await w.github("acme/refs", { "skills/one/SKILL.md": skillMd("one", "One v1"), "skills/two/SKILL.md": skillMd("two", "Two v1") });
    const v1 = repo.head;
    repo.tag("v1.0.0");
    const dev = await repo.branch("dev", { "skills/one/SKILL.md": skillMd("one", "One on dev") });
    const v2 = await repo.commit({ "skills/one/SKILL.md": skillMd("one", "One v2"), "skills/two/SKILL.md": skillMd("two", "Two v2") });
    const one = `${GH}/acme/refs/one`;
    const two = `${GH}/acme/refs/two`;
    const current = async (id: string) => {
      const r = await record(w, id);
      return { commit: r.versions[r.current]!.commit, ref: r.source.ref, description: r.versions[r.current]!.description };
    };

    await w.ok(["add", "acme/refs#dev", "-g", "-y", "-s", "one"]);
    expect(await current(one)).toEqual({ commit: dev, ref: "dev", description: "One on dev" });
    await w.ok(["add", "acme/refs#v1.0.0@two", "-g", "-y"]);
    expect(await current(two)).toEqual({ commit: v1, ref: "v1.0.0", description: "Two v1" });
    await w.ok(["add", "acme/refs@v1.0.0", "-g", "-y", "-s", "one"]);
    expect(await current(one)).toEqual({ commit: v1, ref: "v1.0.0", description: "One v1" });
    await w.ok(["add", `acme/refs#${v2}`, "-g", "-y", "-s", "two"]);
    expect(await current(two)).toEqual({ commit: v2, ref: v2, description: "Two v2" });
    await w.ok(["add", "https://github.com/acme/refs/tree/dev/skills/one", "-g", "-y"]);
    expect(await current(one)).toEqual({ commit: dev, ref: "dev", description: "One on dev" });
    // The default branch, no ref.
    await w.ok(["add", "acme/refs", "-g", "-y", "-s", "one"]);
    expect(await current(one)).toEqual({ commit: v2, ref: null, description: "One v2" });
    expect(Object.keys((await record(w, one)).versions).length).toBe(3);
    const bad = await w.run(["add", "acme/refs#no-such-branch", "-g", "-y"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Failed to clone");
    await validateAll(w);
  });

  test("unsupported and unrecognised sources fail with exit 1 and write nothing", async () => {
    const w = await world();
    const unsupported = [
      "https://raw.githubusercontent.com/acme/skills/main/SKILL.md",
      "https://gitlab.com/acme/skills/-/tree/main/skills",
      "https://example.com/.well-known/skills",
      "https://github.com/acme/skills/archive/main.zip",
    ];
    for (const s of unsupported) {
      const r = await w.run(["add", s, "-g", "-y"]);
      expect(r.code, s).toBe(1);
      expect(r.stderr, s).toContain("not supported by skill-library yet");
    }
    const word = await w.run(["add", "justaword", "-g", "-y"]);
    expect(word.code).toBe(1);
    expect(word.stderr).toContain("Unrecognised source: justaword");
    const traversal = await w.run(["add", "acme/skills/../../etc", "-g", "-y"]);
    expect(traversal.code).toBe(1);
    expect(traversal.stderr).toContain("Unsafe subpath");
    const missingRepo = await w.run(["add", "acme/does-not-exist", "-g", "-y"]);
    expect(missingRepo.code).toBe(1);
    expect(missingRepo.stderr).toContain("Failed to clone https://github.com/acme/does-not-exist.git");
    expectUsageError(await w.run(["add", "-g", "-y"]), "source", "package");
    expect(await exists(path.join(w.store, "index.json"))).toBe(false);
  });
});

describe("add: flags", () => {
  test("-a: one, several, '*', invalid, missing value; global re-adds union the agents; the gateway goes to detected and -a agents", async () => {
    const w = await world();
    await w.dir("home/.claude");
    const src = await w.write(await w.dir("src"), { "a/SKILL.md": skillMd("a", "A"), "b/SKILL.md": skillMd("b", "B") });
    const a = path.join(src, "a");
    const b = path.join(src, "b");

    const rows = await addJson(w, [a, "-g", "-a", "claude-code"]);
    expect(rows[0].agents).toEqual(["Claude Code"]);
    expect((await record(w, `path://${a}`)).agents).toEqual(["claude-code"]);
    await w.ok(["add", a, "-g", "-y", "--agent", "codex", "cursor"]);
    expect((await record(w, `path://${a}`)).agents).toEqual(["claude-code", "codex", "cursor"]);
    await w.ok(["add", a, "-g", "-y", "-a", "*"]);
    expect((await record(w, `path://${a}`)).agents).toBe("all");
    // "all" absorbs later additions.
    await w.ok(["add", a, "-g", "-y", "-a", "codex"]);
    expect((await record(w, `path://${a}`)).agents).toBe("all");
    await w.ok(["add", b, "-g", "-y", "--agent=codex,cursor"]);
    expect((await record(w, `path://${b}`)).agents).toEqual(["codex", "cursor"]);

    const bad = await w.run(["add", a, "-g", "-y", "-a", "nope", "claude-code"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Invalid agents: nope");
    expect(bad.stderr).toMatch(/Valid agents: .*claude-code/);
    expectUsageError(await w.run(["add", a, "-g", "-y", "-a"]), "-a", "--agent");
    const missingSkill = await w.run(["add", a, "-g", "-y", "--skill", "--json"]);
    expectUsageError(missingSkill, "-s", "--skill");
    expectJsonOrNothing(missingSkill);
    // An empty inline value is a missing value, for every list flag of add.
    for (const flag of ["--agent=", "--skill="]) {
      const empty = await w.run(["add", a, "-g", "-y", flag, "--json"]);
      expectUsageError(empty, flag.slice(0, -1));
      expectJsonOrNothing(empty);
    }

    // Detected (Claude Code, from ~/.claude) and requested (Codex and Cursor both read ~/.agents/skills).
    await validateGateway([path.join(w.home, ".claude", "skills"), path.join(w.home, ".agents", "skills")]);
    expect(await exists(path.join(w.home, ".cursor", "skills", "skill-library"))).toBe(false);
    await validateAll(w);
  });

  test("-l / --list prints the skills and writes nothing; --json rejects it", async () => {
    const w = await world();
    const repo = await w.github("acme/list", { "skills/x/SKILL.md": skillMd("x", "Ex marks the spot"), "skills/y/SKILL.md": skillMd("y", "Why not") });
    for (const flag of ["-l", "--list"]) {
      const r = await w.ok(["add", "acme/list", flag]);
      expect(r.stdout).toContain("Available Skills");
      expect(r.stdout).toContain("x\n    Ex marks the spot");
      expect(r.stdout).toContain("y\n    Why not");
      expect(r.stdout).toContain("Use --skill <name> to add specific skills");
    }
    // -l ignores the project scope question.
    const proj = await w.write(await w.dir("proj"), { "skill-library.json": JSON.stringify({ version: 1, skills: {} }) });
    await w.ok(["add", repo.url, "-l"], { cwd: proj });
    const j = await w.run(["add", "acme/list", "-l", "--json", "-y"]);
    expect(j.code).toBe(1);
    expect(j.stderr).toContain("--json cannot be combined with --list");
    expect(j.json()).toEqual([]);
    expect(await exists(path.join(w.store, "index.json"))).toBe(false);
  });

  test("--json: one JSON value on stdout (notices on stderr), needs -y or --all; --all selects every skill and agent", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), { "skills/a/SKILL.md": skillMd("a", "A"), "skills/b/SKILL.md": skillMd("b", "B") });
    const noYes = await w.run(["add", src, "-g", "--json"]);
    expect(noYes.code).toBe(1);
    expect(noYes.stderr).toContain("--json requires -y (or --all)");
    expect(noYes.json()).toEqual([]);
    // A notice (extra positional, unknown option) still leaves stdout as one JSON value.
    const unknown = await w.run(["add", src, "-g", "--all", "--json", "--bogus"]);
    if (!expectUnknownOption(unknown, "--bogus")) expectUsageError(unknown, "--bogus");
    expectJsonOrNothing(unknown);
    const r = await w.ok(["add", src, "extra-arg", "-g", "--all", "--json"]);
    expect(r.stderr).toContain(`Only the first source is used: ${src}`);
    const rows = r.json();
    assertAddJson(rows);
    expect(rows.map((x) => x.name).sort()).toEqual(["a", "b"]);
    for (const row of rows) {
      expect(row.status).toBe("installed");
      expect(row.ref).toBeNull();
      expect(row.hash).toMatch(/^sha256-/);
      expect(row.agents.length).toBeGreaterThan(10);
    }
    const idx = await validateAll(w);
    expect(idx.skills.every((s) => s.agents === "all" && s.global)).toBe(true);
  });

  test("--json reports a failed skill with exit 1 and keeps the others", async () => {
    const w = await world();
    // A SKILL.md that is a symlink is never stored (the copier skips links); its sibling is.
    const src = await w.write(await w.dir("src"), { "skills/good/SKILL.md": skillMd("good", "Good"), "target.md": skillMd("linked", "Linked") });
    await fsp.mkdir(path.join(src, "skills", "linked"), { recursive: true });
    await fsp.symlink(path.join(src, "target.md"), path.join(src, "skills", "linked", "SKILL.md"));
    const r = await w.run(["add", path.join(src, "skills"), "-g", "-y", "--json"]);
    const rows = r.json();
    assertAddJson(rows);
    if (rows.some((x) => x.status === "failed")) {
      expect(r.code).toBe(1);
      expect(rows.find((x) => x.status === "failed")!.error).toBeTruthy();
    } else {
      // The link was rejected before the store write: exit 1 with an error.
      expect(r.code).toBe(1);
    }
    await validateAll(w);
  });

  test("--copy has no effect; --share/--no-share without sync only note; both together is an error", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), { "a/SKILL.md": skillMd("a", "A"), "b/SKILL.md": skillMd("b", "B") });
    await w.ok(["add", path.join(src, "a"), "-g", "-y", "--copy"]);
    const plainW = await world();
    const src2 = await plainW.write(await plainW.dir("src"), { "a/SKILL.md": skillMd("a", "A") });
    await plainW.ok(["add", path.join(src2, "a"), "-g", "-y"]);
    const r1 = await record(w, `path://${path.join(src, "a")}`);
    const r2 = await record(plainW, `path://${path.join(src2, "a")}`);
    expect(r1.versions[r1.current]!.hash).toBe(r2.versions[r2.current]!.hash);
    for (const flag of ["--share", "--no-share"]) {
      const r = await w.ok(["add", path.join(src, "b"), "-g", "-y", flag]);
      expect(r.stderr).toContain("--share/--no-share only apply to global adds while sync is enabled");
    }
    const both = await w.run(["add", path.join(src, "b"), "-g", "-y", "--share", "--no-share"]);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("--share cannot be combined with --no-share");
    await validateAll(w);
  });

  test("without -y and without a TTY a single skill isn't added; inside an agent -y is implied; aliases a / install / i add", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), { "a/SKILL.md": skillMd("a", "A"), "b/SKILL.md": skillMd("b", "B"), "c/SKILL.md": skillMd("c", "C"), "d/SKILL.md": skillMd("d", "D") });
    const r = await w.run(["add", path.join(src, "a"), "-g"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Interactive prompt required but stdin is not a TTY. Nothing was installed. Use -y");
    expect(await exists(path.join(w.store, "index.json"))).toBe(false);
    await w.ok(["add", path.join(src, "a"), "-g"], { env: { CLAUDECODE: "1" } });
    await w.ok(["a", path.join(src, "b"), "-g", "--yes"]);
    await w.ok(["install", path.join(src, "c"), "-g", "-y"]);
    await w.ok(["i", path.join(src, "d"), "-g", "-y", "-a", "codex"]);
    expect((await ids(w)).map((id) => id.split("/").pop())).toEqual(["a", "b", "c", "d"]);
    expect((await record(w, `path://${path.join(src, "d")}`)).agents).toEqual(["codex"]);
    await validateAll(w);
  });
});

describe("add: name clashes", () => {
  test("a global skill whose name is taken replaces the old one, which stays in the store as not global", async () => {
    const w = await world();
    const src = await w.write(await w.dir("src"), { "one/dup/SKILL.md": skillMd("dup", "First copy"), "two/dup/SKILL.md": skillMd("dup", "Second copy") });
    const repo = await w.github("acme/dup", { "SKILL.md": skillMd("dup", "From GitHub") });
    const first = `path://${path.join(src, "one", "dup")}`;
    const second = `path://${path.join(src, "two", "dup")}`;
    await w.ok(["add", path.join(src, "one", "dup"), "-g", "-y"]);
    const r = await w.ok(["add", path.join(src, "two", "dup"), "-g", "-y"]);
    expect(r.stdout).toContain(`Replaced dup (${first}; kept in the store, not global)`);
    let idx = await validateAll(w);
    expect(idx.skills.map((s) => [s.id, s.global])).toEqual([
      [first, false],
      [second, true],
    ]);
    const rows = (await w.ok(["list", "-g", "--json"])).json();
    expect(rows.map((x: any) => [x.id, x.status])).toEqual(
      expect.arrayContaining([
        [first, "untracked"],
        [second, "tracked"],
      ]),
    );
    expect((await w.ok(["list", "-g"])).stdout).toContain("(not global)");
    await w.ok(["add", "acme/dup", "-g", "-y"]);
    idx = await validateAll(w);
    expect(idx.skills.filter((s) => s.global).map((s) => s.id)).toEqual([`${GH}/acme/dup/dup`]);
    expect(idx.skills).toHaveLength(3);
    expect(repo.head).toMatch(/^[0-9a-f]{40}$/);
    // Re-adding the replaced one makes it global again and retires the GitHub one.
    await w.ok(["add", path.join(src, "one", "dup"), "-g", "-y"]);
    idx = await validateAll(w);
    expect(idx.skills.filter((s) => s.global).map((s) => s.id)).toEqual([first]);
    // A project add never replaces anything.
    const proj = await w.dir("proj");
    await w.ok(["add", path.join(src, "two", "dup"), "-p", "-y"], { cwd: proj });
    idx = await validateAll(w, [proj]);
    expect(idx.skills.filter((s) => s.global).map((s) => s.id)).toEqual([first]);
    expect((await readJson(path.join(proj, "skill-library.json"))).skills[second]).toBeTruthy();
  });
});
