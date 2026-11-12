// `init [name] [--always]`: the template, quoting, an existing skill, and that the result is addable.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { world } from "./harness.ts";
import { frontmatter, validateAll } from "./validate.ts";

describe("init", () => {
  test("without a name: ./SKILL.md named after the folder; with a name: <name>/SKILL.md", async () => {
    const w = await world();
    const dir = await w.dir("my-skill");
    const r = await w.ok(["init"], { cwd: dir });
    expect(r.stdout).toContain("Initialized skill: my-skill");
    expect(r.stdout).toContain("Created:\n  SKILL.md");
    expect(r.stdout).toContain("skill-library add ./.");
    expect(r.stdout).not.toContain("metadata.always");
    const fm = await frontmatter(path.join(dir, "SKILL.md"));
    expect(fm).toEqual({ name: "my-skill", description: "A brief description of what this skill does" });
    const text = await fsp.readFile(path.join(dir, "SKILL.md"), "utf8");
    expect(text).toContain("# my-skill");
    expect(text).toContain("## When to use");
    expect(text).toContain("## Instructions");

    const parent = await w.dir("work");
    const named = await w.ok(["init", "reviewer"], { cwd: parent });
    expect(named.stdout).toContain("Initialized skill: reviewer");
    expect(named.stdout).toContain("Created:\n  reviewer/SKILL.md");
    expect(named.stdout).toContain("skill-library add ./reviewer");
    expect((await frontmatter(path.join(parent, "reviewer", "SKILL.md"))).name).toBe("reviewer");
    expect(await fsp.readdir(parent)).toEqual(["reviewer"]);
  });

  test("--always marks the skill always-on, before or after the name", async () => {
    const w = await world();
    const dir = await w.dir("p");
    for (const args of [["init", "--always", "first"], ["init", "second", "--always"]]) {
      const r = await w.ok(args, { cwd: dir });
      expect(r.stdout).toContain("metadata.always: true — every query returns this skill, without scoring");
    }
    for (const n of ["first", "second"]) {
      const fm = await frontmatter(path.join(dir, n, "SKILL.md"));
      expect(fm.name).toBe(n);
      expect(fm.metadata).toEqual({ always: true });
    }
    // Without a name too.
    const own = await w.dir("own");
    await w.ok(["init", "--always"], { cwd: own });
    expect((await frontmatter(path.join(own, "SKILL.md"))).metadata).toEqual({ always: true });
  });

  test("an existing skill is left untouched (exit 0)", async () => {
    const w = await world();
    const dir = await w.dir("p");
    await w.ok(["init", "keep"], { cwd: dir });
    const file = path.join(dir, "keep", "SKILL.md");
    await fsp.writeFile(file, "---\nname: keep\ndescription: Edited by hand\n---\n");
    for (const args of [["init", "keep"], ["init", "keep", "--always"]]) {
      const r = await w.ok(args, { cwd: dir });
      expect(r.stdout).toContain("Skill already exists at keep/SKILL.md");
      expect(await fsp.readFile(file, "utf8")).toBe("---\nname: keep\ndescription: Edited by hand\n---\n");
    }
    const here = path.join(dir, "keep");
    expect((await w.ok(["init"], { cwd: here })).stdout).toContain("Skill already exists at SKILL.md");
  });

  test("names that need YAML quoting round-trip as strings", async () => {
    const w = await world();
    const dir = await w.dir("p");
    for (const name of ["a: b", "yes", "123", "true", "null", "#hash", "it's", "[list]"]) {
      await w.ok(["init", name], { cwd: dir });
      const fm = await frontmatter(path.join(dir, name, "SKILL.md"));
      expect(fm.name, name).toBe(name);
      expect(typeof fm.name).toBe("string");
    }
  });

  test("the created skills can be added; the library validates", async () => {
    const w = await world();
    const dir = await w.dir("p");
    await w.ok(["init", "fresh"], { cwd: dir });
    await w.ok(["init", "steady", "--always"], { cwd: dir });
    await w.ok(["init", "yes"], { cwd: dir });
    for (const n of ["fresh", "steady", "yes"]) await w.ok(["add", `./${n}`, "-g", "-y"], { cwd: dir });
    const index = await validateAll(w);
    expect(index.skills.map((s) => s.versions[s.current]!.name).sort()).toEqual(["fresh", "steady", "yes"]);
    for (const s of index.skills) expect(s.versions[s.current]!.description).toBe("A brief description of what this skill does");
  });
});
