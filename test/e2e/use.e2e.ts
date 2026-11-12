// `use <source>[@skill]`: print a prompt for one skill, or start an agent with it. Never writes to
// the library.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { exists, skillMd, world, type World } from "./harness.ts";

const HEAD = "You are being given a Skill to execute for the user's next request.\n\nUse the following SKILL.md as your instructions:\n\n";

function prompt(md: string): string {
  return `${HEAD}<SKILL.md>\n${md}\n</SKILL.md>\n`;
}

async function source(w: World): Promise<{ dir: string; a: string; b: string; ref: string }> {
  const a = skillMd("alpha", "Alpha skill", "Do alpha things.");
  const b = skillMd("beta", "Beta skill", "See ./ref/guide.md");
  const dir = await w.write(await w.dir("src"), {
    "skills/alpha/SKILL.md": a,
    "skills/beta/SKILL.md": b,
    "skills/beta/ref/guide.md": "# Guide\nstep one\n",
    "skills/beta/run.sh": "#!/bin/sh\necho hi\n",
  });
  return { dir, a, b, ref: "# Guide\nstep one\n" };
}

describe("use", () => {
  test("a single-skill source prints the prompt with SKILL.md verbatim; nothing is stored", async () => {
    const w = await world();
    const md = skillMd("solo", "Solo skill", "Body with `code` and <tags>.");
    const dir = await w.write(await w.dir("solo"), { "SKILL.md": md });
    const r = await w.ok(["use", dir]);
    expect(r.stdout).toBe(prompt(md));
    expect(r.stderr).toBe("");
    // Relative local paths work too.
    expect((await w.ok(["use", "./solo"])).stdout).toBe(prompt(md));
    expect(await exists(w.store)).toBe(false);
    expect(await fsp.readdir(w.home)).toEqual([]);
  });

  test("several skills: a selector is required (@skill, -s, --skill; case-insensitive)", async () => {
    const w = await world();
    const { dir, a, b } = await source(w);
    const many = await w.run(["use", dir]);
    expect(many.code).toBe(1);
    expect(many.stdout).toBe("");
    expect(many.stderr).toContain("This source contains multiple skills. Specify exactly one skill:\n  - alpha\n  - beta");
    expect(many.stderr).toContain(`skill-library use ${dir}@alpha`);
    expect(many.stderr).toContain(`skill-library use ${dir} --skill alpha`);

    expect((await w.ok(["use", dir, "-s", "alpha"])).stdout).toBe(prompt(a));
    expect((await w.ok(["use", dir, "--skill", "ALPHA"])).stdout).toBe(prompt(a));
    expect((await w.ok(["use", dir, "--skill=alpha"])).stdout).toBe(prompt(a));
    expect((await w.ok(["use", "-s", "beta", dir])).stdout).toContain(`<SKILL.md>\n${b}\n</SKILL.md>`);
    expect(await exists(w.store)).toBe(false);
  });

  test("selector errors: conflicting selectors, no match lists the available skills", async () => {
    const w = await world();
    const repo = await w.github("acme/tools", { "skills/alpha/SKILL.md": skillMd("alpha", "A"), "skills/beta/SKILL.md": skillMd("beta", "B") });
    const conflict = await w.run(["use", `${repo.slug}@alpha`, "-s", "beta"]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('Conflicting skill selectors: source selects "alpha" but --skill selects "beta". Provide one selector.');
    // The same selector twice is fine.
    expect((await w.run(["use", `${repo.slug}@alpha`, "-s", "Alpha"])).code).toBe(0);

    const { dir } = await source(w);
    const none = await w.run(["use", dir, "-s", "gamma"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No matching skill found for: gamma");
    expect(none.stderr).toContain("Available skills:\n  - alpha\n  - beta");

    const empty = await w.write(await w.dir("empty"), { "README.md": "no skills here" });
    const noSkills = await w.run(["use", empty]);
    expect(noSkills.code).toBe(1);
    expect(noSkills.stderr).toContain("No valid skills found. Skills require a SKILL.md with name and description.");
  });

  test("supporting files are copied to a temp folder named in the prompt", async () => {
    const w = await world();
    const { dir, b, ref } = await source(w);
    const r = await w.ok(["use", dir, "-s", "beta"]);
    const m = r.stdout.match(/Supporting files for this skill were downloaded to:\n(.+)\n\nWhen the SKILL.md references relative paths, read them from that directory\.\n$/);
    expect(m, r.stdout).not.toBeNull();
    const support = m![1]!;
    expect(support.startsWith(w.env.TMPDIR!)).toBe(true);
    expect(path.basename(support)).toBe("beta");
    expect(await fsp.readFile(path.join(support, "SKILL.md"), "utf8")).toBe(b);
    expect(await fsp.readFile(path.join(support, "ref", "guide.md"), "utf8")).toBe(ref);
    expect(await fsp.readFile(path.join(support, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    // A skill without supporting files leaves no temp folder behind and says nothing about one.
    const before = await fsp.readdir(w.env.TMPDIR!);
    const alpha = await w.ok(["use", dir, "-s", "alpha"]);
    expect(alpha.stdout).not.toContain("Supporting files");
    expect((await fsp.readdir(w.env.TMPDIR!)).filter((d) => d.startsWith("skill-library-use-")).length).toBe(before.filter((d) => d.startsWith("skill-library-use-")).length);
  });

  test("--full-depth finds skills nested below a root skill", async () => {
    const w = await world();
    const root = skillMd("root", "Root skill");
    const inner = skillMd("inner", "Inner skill");
    const dir = await w.write(await w.dir("nested"), { "SKILL.md": root, "deep/er/inner/SKILL.md": inner });
    // Without --full-depth the root skill is the source; its nested folder is a supporting file.
    const top = (await w.ok(["use", dir])).stdout;
    expect(top.startsWith(prompt(root))).toBe(true);
    expect(top).toContain("Supporting files for this skill were downloaded to:");
    const shallow = await w.run(["use", dir, "-s", "inner"]);
    expect(shallow.code).toBe(1);
    expect(shallow.stderr).toContain("No matching skill found for: inner");
    const many = await w.run(["use", dir, "--full-depth"]);
    expect(many.code).toBe(1);
    expect(many.stderr).toContain("  - root\n  - inner");
    expect((await w.ok(["use", dir, "--full-depth", "-s", "inner"])).stdout).toContain(`<SKILL.md>\n${inner}\n</SKILL.md>`);
  });

  test("GitHub sources: owner/repo@skill, #ref, #ref@skill, github: and URLs", async () => {
    const w = await world();
    const a1 = skillMd("alpha", "Alpha v1");
    const repo = await w.github("acme/tools", { "skills/alpha/SKILL.md": a1, "skills/beta/SKILL.md": skillMd("beta", "Beta") });
    const a2 = skillMd("alpha", "Alpha on dev");
    await repo.branch("dev", { "skills/alpha/SKILL.md": a2 });
    expect((await w.ok(["use", "acme/tools@alpha"])).stdout).toBe(prompt(a1));
    expect((await w.ok(["use", "acme/tools", "--skill", "alpha"])).stdout).toBe(prompt(a1));
    expect((await w.ok(["use", "acme/tools#dev@alpha"])).stdout).toBe(prompt(a2));
    expect((await w.ok(["use", "acme/tools#dev", "-s", "alpha"])).stdout).toBe(prompt(a2));
    expect((await w.ok(["use", "acme/tools/skills/alpha"])).stdout).toBe(prompt(a1));
    expect((await w.ok(["use", "github:acme/tools@alpha"])).stdout).toBe(prompt(a1));
    expect((await w.ok(["use", "https://github.com/acme/tools/tree/dev/skills/alpha"])).stdout).toBe(prompt(a2));
    expect((await w.ok(["use", repo.url, "-s", "alpha"])).stdout).toBe(prompt(a1));
    const missing = await w.run(["use", "acme/nope@alpha"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Failed to clone https://github.com/acme/nope.git");
    expect(await exists(w.store)).toBe(false);
  });

  test("-a starts claude-code, codex or sarvam-code with the prompt as its one argument and passes its exit code", async () => {
    const w = await world();
    const md = skillMd("solo", "Solo");
    const dir = await w.write(await w.dir("solo"), { "SKILL.md": md });
    for (const [agent, command, code] of [["claude-code", "claude", 0], ["codex", "codex", 7], ["sarvam-code", "sarvam-code", 3]] as const) {
      const fake = await w.fakeAgent(command, code);
      const r = await w.run(["use", dir, "-a", agent]);
      expect(r.code, agent).toBe(code);
      expect(r.stdout).toBe("");
      expect(await fake.calls()).toEqual([[prompt(md)]]);
    }
    const long = await w.fakeAgent("claude", 0);
    await w.ok(["use", dir, "--agent", "claude-code"]);
    expect((await long.calls()).at(-1)).toEqual([prompt(md)]);
  });

  test("agent errors: not on PATH, not supported, '*', two agents, invalid, missing value", async () => {
    const w = await world();
    const dir = await w.write(await w.dir("solo"), { "SKILL.md": skillMd("solo", "Solo") });
    const notFound = await w.run(["use", dir, "-a", "codex"]);
    expect(notFound.code).toBe(1);
    expect(notFound.stderr).toContain("Could not launch Codex: command not found: codex");

    const cursor = await w.run(["use", dir, "-a", "cursor"]);
    expect(cursor.code).toBe(1);
    expect(cursor.stderr).toContain("Running Cursor is not supported yet.");
    expect(cursor.stderr).toContain("Supported agents for skill-library use --agent: claude-code, codex, sarvam-code");

    const star = await w.run(["use", dir, "-a", "*"]);
    expect(star.code).toBe(1);
    expect(star.stderr).toContain("skill-library use --agent does not support '*'; specify exactly one agent.");

    const two = await w.run(["use", dir, "-a", "codex", "claude-code"]);
    expect(two.code).toBe(1);
    expect(two.stderr).toContain("skill-library use --agent accepts exactly one agent.");

    const invalid = await w.run(["use", dir, "-a", "nope"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Invalid agents: nope");
    expect(invalid.stderr).toMatch(/Valid agents: .*claude-code/);

    // -a and --agent are the same option: same behaviour, same message.
    for (const flag of ["-a", "--agent"]) {
      const missing = await w.run(["use", dir, flag]);
      expect(missing.code, flag).toBe(1);
      expect(missing.stderr).toContain(`${flag} requires an agent name`);
      const empty = await w.run(["use", dir, `${flag}=`]);
      expect(empty.code, `${flag}=`).toBe(1);
    }
    const missingSkill = await w.run(["use", dir, "-s"]);
    expect(missingSkill.code).toBe(1);
    expect(missingSkill.stderr).toContain("-s requires a value");
    for (const flag of ["--skill", "--skill="]) {
      const r = await w.run(["use", dir, flag]);
      expect(r.code, flag).toBe(1);
      expect(r.stderr).toContain("--skill requires a value");
    }
  });

  test("argument errors: missing source shows help, two sources, unknown options are errors, missing path", async () => {
    const w = await world();
    const none = await w.run(["use"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("Missing required argument: source");
    expect(none.stderr).toContain("Usage: skill-library use <source>[@<skill>] [options]");

    const two = await w.run(["use", "./a", "./b"]);
    expect(two.code).toBe(1);
    expect(two.stderr).toContain("Expected one source, received 2: ./a, ./b");

    const unknown = await w.run(["use", "./a", "--bogus", "--yes"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown option: --bogus");
    expect(unknown.stderr).toContain("Unknown option: --yes");

    const gone = await w.run(["use", "./does-not-exist"]);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain(`Local path does not exist: ${path.join(w.root, "does-not-exist")}`);

    const bad = await w.run(["use", "https://example.com/some/page"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("not supported by skill-library yet");

    for (const flag of ["--help", "-h"]) {
      const r = await w.ok(["use", flag]);
      expect(r.stdout).toContain("Usage: skill-library use <source>[@<skill>] [options]");
      for (const opt of ["-s, --skill", "-a, --agent", "--full-depth"]) expect(r.stdout).toContain(opt);
    }
    expect(await exists(w.store)).toBe(false);
  });
});
