// One realistic run through the whole product, two machines, every step validated: author skills,
// publish them, find them, add them globally and to a project, query, update, restore on another
// machine, sync global skills between the machines, use one without adding it, clean up.
import { describe, expect, onTestFinished, test } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fakeSkillsSh, fakeTypeSafe } from "./fakes.ts";
import { exists, readJson, skillMd, world } from "./harness.ts";
import { assertQueryJson, remoteFiles, validateAll, validateGateway, validateManifest, validateSync } from "./validate.ts";

describe("journey", () => {
  test("author → publish → find → add → query → update → install elsewhere → sync → use → remove", async () => {
    const machineA = await world();

    await machineA.dir("home/.claude"); // Claude Code is installed on machine A
    const ts = await fakeTypeSafe();
    const sh = await fakeSkillsSh();

    onTestFinished(() => Promise.all([ts.close(), sh.close()]).then(() => undefined));
    const services = { SKILL_LIBRARY_TYPESAFE_API_BASE: ts.url, SKILL_LIBRARY_TYPESAFE_API_KEY: "k", SKILLS_API_URL: sh.url };

    // 1. Author two skills with `init` and publish them as github.com/acme/team-skills.
    const authoring = await machineA.dir("authoring");

    await machineA.ok(["init", "code-review"], { cwd: authoring });
    await machineA.ok(["init", "release-notes", "--always"], { cwd: authoring });
    const reviewMd = (await fsp.readFile(path.join(authoring, "code-review", "SKILL.md"), "utf8")).replace(
      "A brief description of what this skill does",
      "Review pull requests for correctness and style",
    );
    const notesMd = (await fsp.readFile(path.join(authoring, "release-notes", "SKILL.md"), "utf8")).replace(
      "A brief description of what this skill does",
      "Write release notes for every change",
    );
    const upstream = await machineA.github("acme/team-skills", {
      "skills/code-review/SKILL.md": reviewMd,
      "skills/code-review/checklist.md": "- tests\n- naming\n",
      "skills/release-notes/SKILL.md": notesMd,
      "skills/database-migrations/SKILL.md": skillMd("database-migrations", "Plan safe database schema migrations"),
    });

    sh.hits = [{ slug: "acme/team-skills/code-review", name: "code-review", source: "acme/team-skills", installs: 4200 }];

    // 2. Find it.
    const found = await machineA.ok(["find", "review"], { env: services });

    expect(found.stdout).toContain("acme/team-skills@code-review 4.2K installs");

    // 3. Add code-review and release-notes globally, for Claude Code only.
    const added = await machineA.ok(["add", "acme/team-skills", "-g", "-y", "-s", "code-review", "release-notes", "-a", "claude-code", "--json"]);

    expect(added.json().map((row: any) => [row.name, row.status, row.scope, row.agents])).toEqual([
      ["code-review", "installed", "global", ["Claude Code"]],
      ["release-notes", "installed", "global", ["Claude Code"]],
    ]);
    const index = await validateAll(machineA);

    expect(index.skills.map((skill) => skill.id)).toEqual(["repo://github.com/acme/team-skills/code-review", "repo://github.com/acme/team-skills/release-notes"]);
    expect(index.skills.every((skill) => skill.versions[skill.current]!.commit === upstream.head)).toBe(true);
    await validateGateway([path.join(machineA.home, ".claude", "skills")]);

    // 4. A project pins database-migrations from GitHub and uses an in-repo skill in place.
    const proj = await machineA.dir("webapp");

    await machineA.write(proj, { "tools/skills/deploy/SKILL.md": skillMd("deploy", "Deploy the webapp to production") });
    await machineA.ok(["add", "acme/team-skills@database-migrations", "-p", "-y"], { cwd: proj });
    await machineA.ok(["add", "./tools/skills/deploy", "-p", "-y"], { cwd: proj });
    let manifest = await validateManifest(machineA, proj);

    expect(Object.keys(manifest.skills)).toEqual(["local://tools/skills/deploy", "repo://github.com/acme/team-skills/database-migrations"]);
    expect(manifest.skills["repo://github.com/acme/team-skills/database-migrations"]!.commit).toBe(upstream.head);
    await validateAll(machineA, [proj]);
    const projectList = (await machineA.ok(["list", "--json"], { cwd: proj })).json();

    expect(projectList.map((row: any) => [row.name, row.scope, row.status])).toEqual([
      ["database-migrations", "project", "tracked"],
      ["deploy", "project", "tracked"],
    ]);

    // 5. Query from inside the project: always-on first, then scored project + global skills.
    const queryResult = await machineA.ok(["query", "plan the database migrations and deploy them", "--json", "-a", "claude-code"], { cwd: proj, env: services });
    const out = queryResult.json();

    assertQueryJson(out);
    expect(out.matches.map((match: any) => [match.name, match.scope, match.always])).toEqual([
      ["release-notes", "global", true],
      ["database-migrations", "project", false],
      ["deploy", "project", false],
    ]);

    for (const match of out.matches) {
      expect(await exists(match.path), match.path).toBe(true);
    }

    expect(await fsp.readFile(out.matches[2].path, "utf8")).toContain("Deploy the webapp");

    // 6. Upstream improves database-migrations: check reports it, update moves the pin.
    const v2 = await upstream.commit({ "skills/database-migrations/SKILL.md": skillMd("database-migrations", "Plan safe, reversible database schema migrations") });
    const check = await machineA.run(["check"], { cwd: proj });

    expect(check.code).toBe(1);
    expect(check.stdout).toContain("database-migrations has an update");
    expect(await readJson(path.join(proj, "skill-library.json"))).toEqual(manifest); // check writes nothing
    await machineA.ok(["update"], { cwd: proj });
    manifest = await validateManifest(machineA, proj);
    expect(manifest.skills["repo://github.com/acme/team-skills/database-migrations"]!.commit).toBe(v2);
    expect((await machineA.ok(["check"], { cwd: proj })).stdout).toContain("All skills are up to date.");
    await validateAll(machineA, [proj]);
    // Global skills were untouched by the project update (code-review's folder didn't change upstream).
    expect((await machineA.ok(["check", "-g"])).stdout).toContain("All skills are up to date.");

    // 7. Machine B clones the project and restores it from skill-library.json.
    const machineB = await machineA.machine("laptop");
    const projB = await machineB.dir("webapp");

    await fsp.cp(proj, projB, { recursive: true });
    const restored = await machineB.ok(["install"], { cwd: projB });

    expect(restored.stdout).toContain("Installed repo://github.com/acme/team-skills/database-migrations");
    expect(restored.stdout).toContain("local://tools/skills/deploy (in this repository)");
    await validateManifest(machineB, projB);
    await validateAll(machineB, [projB]);
    expect((await machineB.ok(["install"], { cwd: projB })).stdout).toContain("Everything is already installed.");

    // 8. Sync global skills through a private repo: A seeds it, B joins and gets the same skills.
    const remote = await machineA.emptyRemote("my-skills");

    await machineA.ok(["sync", "init", remote]);
    await validateSync(machineA, { settled: true });
    const seeded = await remoteFiles(machineA, remote);

    expect(Object.keys(seeded.manifest!.skills).sort()).toEqual(["repo://github.com/acme/team-skills/code-review", "repo://github.com/acme/team-skills/release-notes"]);
    expect(seeded.files).toContain("README.md");
    await machineB.ok(["sync", "init", remote]);
    await validateSync(machineB, { settled: true });
    const globalsB = (await machineB.ok(["list", "-g", "--json"], { cwd: machineB.home })).json().filter((row: any) => row.status === "tracked").map((row: any) => row.name)
      .sort();

    expect(globalsB).toEqual(["code-review", "release-notes"]);

    // B adds a global skill; A picks it up on its next sync.
    await machineB.ok(["add", "acme/team-skills@database-migrations", "-g", "-y"]);
    await validateSync(machineB, { settled: true });
    const synced = await machineA.ok(["sync"]);

    expect(synced.stdout).toContain("+ database-migrations");
    expect(synced.stdout).toContain(`Synced global skills with ${remote}`);
    await validateSync(machineA, { settled: true });
    await validateAll(machineA, [proj]);

    // 9. Use a skill without adding it: prompt carries the SKILL.md and its supporting file folder.
    const used = await machineA.ok(["use", "acme/team-skills@code-review"]);

    expect(used.stdout).toContain("<SKILL.md>");
    expect(used.stdout).toContain("Review pull requests for correctness and style");
    expect(used.stdout).toContain("Supporting files for this skill were downloaded to:");

    // 10. Clean up: drop the project reference, delete a global skill (the deletion syncs to B).
    await machineA.ok(["remove", "-p", "database-migrations", "-y"], { cwd: proj });
    manifest = await validateManifest(machineA, proj);
    expect(Object.keys(manifest.skills)).toEqual(["local://tools/skills/deploy"]);
    await machineA.ok(["remove", "-g", "code-review", "-y"]);
    await validateSync(machineA, { settled: true });
    expect(Object.keys((await remoteFiles(machineA, remote)).manifest!.skills)).not.toContain("repo://github.com/acme/team-skills/code-review");
    await machineB.ok(["sync"]);
    await validateSync(machineB, { settled: true });
    const afterB = (await machineB.ok(["list", "-g", "--json"], { cwd: machineB.home })).json();

    expect(afterB.find((row: any) => row.name === "code-review")?.status).not.toBe("tracked");
    await validateAll(machineA, [proj]);
    await validateAll(machineB, [projB]);
  });
});
