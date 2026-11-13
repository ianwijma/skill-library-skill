// `use <source>[@skill]`: print a prompt for one skill, or start an agent with it. Never writes to
// the library.
import { describe, expect, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { exists, skillMd, world, type World } from "./harness.ts";
import { expectUsageError } from "./contract.ts";

const HEAD = "You are being given a Skill to execute for the user's next request.\n\nUse the following SKILL.md as your instructions:\n\n";

function prompt(md: string): string {
  return `${HEAD}<SKILL.md>\n${md}\n</SKILL.md>\n`;
}

async function source(testWorld: World): Promise<{ dir: string; alphaMd: string; betaMd: string; ref: string }> {
  const alphaMd = skillMd("alpha", "Alpha skill", "Do alpha things.");
  const betaMd = skillMd("beta", "Beta skill", "See ./ref/guide.md");
  const dir = await testWorld.write(await testWorld.dir("src"), {
    "skills/alpha/SKILL.md": alphaMd,
    "skills/beta/SKILL.md": betaMd,
    "skills/beta/ref/guide.md": "# Guide\nstep one\n",
    "skills/beta/run.sh": "#!/bin/sh\necho hi\n",
  });

  return { dir, alphaMd, betaMd, ref: "# Guide\nstep one\n" };
}

describe("use", () => {
  test("a single-skill source prints the prompt with SKILL.md verbatim; nothing is stored", async () => {
    const testWorld = await world();
    const md = skillMd("solo", "Solo skill", "Body with `code` and <tags>.");
    const dir = await testWorld.write(await testWorld.dir("solo"), { "SKILL.md": md });
    const result = await testWorld.ok(["use", dir]);

    expect(result.stdout).toBe(prompt(md));
    expect(result.stderr).toBe("");
    // Relative local paths work too.
    expect((await testWorld.ok(["use", "./solo"])).stdout).toBe(prompt(md));
    expect(await exists(testWorld.store)).toBe(false);
    expect(await fsp.readdir(testWorld.home)).toEqual([]);
  });

  test("several skills: a selector is required (@skill, -s, --skill; case-insensitive)", async () => {
    const testWorld = await world();
    const { dir, alphaMd, betaMd } = await source(testWorld);
    const many = await testWorld.run(["use", dir]);

    expect(many.code).toBe(1);
    expect(many.stdout).toBe("");
    expect(many.stderr).toContain("This source contains multiple skills. Specify exactly one skill:\n  - alpha\n  - beta");
    expect(many.stderr).toContain(`skill-library use ${dir}@alpha`);
    expect(many.stderr).toContain(`skill-library use ${dir} --skill alpha`);

    expect((await testWorld.ok(["use", dir, "-s", "alpha"])).stdout).toBe(prompt(alphaMd));
    expect((await testWorld.ok(["use", dir, "--skill", "ALPHA"])).stdout).toBe(prompt(alphaMd));
    expect((await testWorld.ok(["use", dir, "--skill=alpha"])).stdout).toBe(prompt(alphaMd));
    expect((await testWorld.ok(["use", "-s", "beta", dir])).stdout).toContain(`<SKILL.md>\n${betaMd}\n</SKILL.md>`);
    expect(await exists(testWorld.store)).toBe(false);
  });

  test("selector errors: conflicting selectors, no match lists the available skills", async () => {
    const testWorld = await world();
    const repo = await testWorld.github("acme/tools", { "skills/alpha/SKILL.md": skillMd("alpha", "A"), "skills/beta/SKILL.md": skillMd("beta", "B") });
    const conflict = await testWorld.run(["use", `${String(repo.slug)}@alpha`, "-s", "beta"]);

    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('Conflicting skill selectors: source selects "alpha" but --skill selects "beta". Provide one selector.');
    // The same selector twice is fine.
    expect((await testWorld.run(["use", `${String(repo.slug)}@alpha`, "-s", "Alpha"])).code).toBe(0);

    const { dir } = await source(testWorld);
    const none = await testWorld.run(["use", dir, "-s", "gamma"]);

    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No matching skill found for: gamma");
    expect(none.stderr).toContain("Available skills:\n  - alpha\n  - beta");

    const empty = await testWorld.write(await testWorld.dir("empty"), { "README.md": "no skills here" });
    const noSkills = await testWorld.run(["use", empty]);

    expect(noSkills.code).toBe(1);
    expect(noSkills.stderr).toContain("No valid skills found. Skills require a SKILL.md with name and description.");
  });

  test("supporting files are copied to a temp folder named in the prompt", async () => {
    const testWorld = await world();
    const { dir, betaMd, ref } = await source(testWorld);
    const result = await testWorld.ok(["use", dir, "-s", "beta"]);
    const match = result.stdout.match(/Supporting files for this skill were downloaded to:\n(.+)\n\nWhen the SKILL.md references relative paths, read them from that directory\.\n$/);

    expect(match, result.stdout).not.toBeNull();
    const support = match![1]!;

    expect(support.startsWith(testWorld.env.TMPDIR!)).toBe(true);
    expect(path.basename(support)).toBe("beta");
    expect(await fsp.readFile(path.join(support, "SKILL.md"), "utf8")).toBe(betaMd);
    expect(await fsp.readFile(path.join(support, "ref", "guide.md"), "utf8")).toBe(ref);
    expect(await fsp.readFile(path.join(support, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    // A skill without supporting files leaves no temp folder behind and says nothing about one.
    const before = await fsp.readdir(testWorld.env.TMPDIR!);
    const alpha = await testWorld.ok(["use", dir, "-s", "alpha"]);

    expect(alpha.stdout).not.toContain("Supporting files");
    expect((await fsp.readdir(testWorld.env.TMPDIR!)).filter((entry) => entry.startsWith("skill-library-use-")).length).toBe(before.filter((entry) => entry.startsWith("skill-library-use-")).length);
  });

  test("--full-depth finds skills nested below a root skill", async () => {
    const testWorld = await world();
    const root = skillMd("root", "Root skill");
    const inner = skillMd("inner", "Inner skill");
    const dir = await testWorld.write(await testWorld.dir("nested"), { "SKILL.md": root, "deep/er/inner/SKILL.md": inner });
    // Without --full-depth the root skill is the source; its nested folder is a supporting file.
    const top = (await testWorld.ok(["use", dir])).stdout;

    expect(top.startsWith(prompt(root))).toBe(true);
    expect(top).toContain("Supporting files for this skill were downloaded to:");
    const shallow = await testWorld.run(["use", dir, "-s", "inner"]);

    expect(shallow.code).toBe(1);
    expect(shallow.stderr).toContain("No matching skill found for: inner");
    const many = await testWorld.run(["use", dir, "--full-depth"]);

    expect(many.code).toBe(1);
    expect(many.stderr).toContain("  - root\n  - inner");
    expect((await testWorld.ok(["use", dir, "--full-depth", "-s", "inner"])).stdout).toContain(`<SKILL.md>\n${inner}\n</SKILL.md>`);
  });

  test("GitHub sources: owner/repo@skill, #ref, #ref@skill, github: and URLs", async () => {
    const testWorld = await world();
    const a1 = skillMd("alpha", "Alpha v1");
    const repo = await testWorld.github("acme/tools", { "skills/alpha/SKILL.md": a1, "skills/beta/SKILL.md": skillMd("beta", "Beta") });
    const a2 = skillMd("alpha", "Alpha on dev");

    await repo.branch("dev", { "skills/alpha/SKILL.md": a2 });
    expect((await testWorld.ok(["use", "acme/tools@alpha"])).stdout).toBe(prompt(a1));
    expect((await testWorld.ok(["use", "acme/tools", "--skill", "alpha"])).stdout).toBe(prompt(a1));
    expect((await testWorld.ok(["use", "acme/tools#dev@alpha"])).stdout).toBe(prompt(a2));
    expect((await testWorld.ok(["use", "acme/tools#dev", "-s", "alpha"])).stdout).toBe(prompt(a2));
    expect((await testWorld.ok(["use", "acme/tools/skills/alpha"])).stdout).toBe(prompt(a1));
    expect((await testWorld.ok(["use", "github:acme/tools@alpha"])).stdout).toBe(prompt(a1));
    expect((await testWorld.ok(["use", "https://github.com/acme/tools/tree/dev/skills/alpha"])).stdout).toBe(prompt(a2));
    expect((await testWorld.ok(["use", repo.url, "-s", "alpha"])).stdout).toBe(prompt(a1));
    const missing = await testWorld.run(["use", "acme/nope@alpha"]);

    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Failed to clone https://github.com/acme/nope.git");
    expect(await exists(testWorld.store)).toBe(false);
  });

  test("-a starts claude-code, codex or sarvam-code with the prompt as its one argument and passes its exit code", async () => {
    const testWorld = await world();
    const md = skillMd("solo", "Solo");
    const dir = await testWorld.write(await testWorld.dir("solo"), { "SKILL.md": md });

    for (const [agent, command, code] of [["claude-code", "claude", 0], ["codex", "codex", 7], ["sarvam-code", "sarvam-code", 3]] as const) {
      const fake = await testWorld.fakeAgent(command, code);
      const result = await testWorld.run(["use", dir, "-a", agent]);

      expect(result.code, agent).toBe(code);
      expect(result.stdout).toBe("");
      expect(await fake.calls()).toEqual([[prompt(md)]]);
    }

    const long = await testWorld.fakeAgent("claude", 0);

    await testWorld.ok(["use", dir, "--agent", "claude-code"]);
    expect((await long.calls()).at(-1)).toEqual([prompt(md)]);
  });

  test("agent errors: not on PATH, not supported, '*', two agents, invalid, missing value", async () => {
    const testWorld = await world();
    const dir = await testWorld.write(await testWorld.dir("solo"), { "SKILL.md": skillMd("solo", "Solo") });
    const notFound = await testWorld.run(["use", dir, "-a", "codex"]);

    expect(notFound.code).toBe(1);
    expect(notFound.stderr).toContain("Could not launch Codex: command not found: codex");

    const cursor = await testWorld.run(["use", dir, "-a", "cursor"]);

    expect(cursor.code).toBe(1);
    expect(cursor.stderr).toContain("Running Cursor is not supported yet.");
    expect(cursor.stderr).toContain("Supported agents for skill-library use --agent: claude-code, codex, sarvam-code");

    const star = await testWorld.run(["use", dir, "-a", "*"]);

    expect(star.code).toBe(1);
    expect(star.stderr).toContain("skill-library use --agent does not support '*'; specify exactly one agent.");

    const two = await testWorld.run(["use", dir, "-a", "codex", "claude-code"]);

    expect(two.code).toBe(1);
    expect(two.stderr).toContain("skill-library use --agent accepts exactly one agent.");

    const invalid = await testWorld.run(["use", dir, "-a", "nope"]);

    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Invalid agents: nope");
    expect(invalid.stderr).toMatch(/Valid agents: .*claude-code/);

    // -a and --agent are the same option: same behaviour, same message.
    for (const flag of ["-a", "--agent"]) {
      expectUsageError(await testWorld.run(["use", dir, flag]), "-a", "--agent");
      expectUsageError(await testWorld.run(["use", dir, `${flag}=`]), "-a", "--agent");
    }

    for (const flag of ["-s", "--skill", "--skill="]) {
      expectUsageError(await testWorld.run(["use", dir, flag]), "-s", "--skill");
    }
  });

  test("argument errors: missing source, two sources, unknown options are errors, missing path", async () => {
    const testWorld = await world();

    expectUsageError(await testWorld.run(["use"]), "source");

    const two = await testWorld.run(["use", "./a", "./b"]);

    expect(two.code).toBe(1);
    expect(two.stderr).toContain("Expected one source, received 2: ./a, ./b");

    // use never warns-and-continues: it might launch an agent with options it didn't understand.
    expectUsageError(await testWorld.run(["use", "./a", "--bogus"]), "--bogus");
    expectUsageError(await testWorld.run(["use", "./a", "--yes"]), "--yes");

    const gone = await testWorld.run(["use", "./does-not-exist"]);

    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain(`Local path does not exist: ${path.join(testWorld.root, "does-not-exist")}`);

    const bad = await testWorld.run(["use", "https://example.com/some/page"]);

    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("not supported by skill-library yet");

    expect(await exists(testWorld.store)).toBe(false);
  });
});
