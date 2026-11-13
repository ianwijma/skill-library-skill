import * as prompts from "@clack/prompts";
import pc from "picocolors";
import { removableSkills, removeSkills } from "../core/remove.ts";
import { CliError, formatError, note, sanitizeMetadata } from "../lib/cli.ts";
import { isRunningInAgent } from "../lib/detect-agent.ts";
import { loadProject } from "../lib/manifest.ts";
import { afterGlobalChange } from "./sync/shared.ts";
import { type Ctx, examples, list, newCommand, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

/** TTY picker for a name that matches several skills. */
export async function pickAmbiguous(selector: string, ids: string[]): Promise<string | null> {
  const picked = await prompts.select({ message: `"${selector}" matches several skills — which one?`, options: ids.map((id) => ({ value: id, label: id })) });

  return prompts.isCancel(picked) ? null : (picked);
}

interface RemoveOptions {
  global?: boolean;
  project?: boolean;
  yes?: boolean;
  all?: boolean;
  agent?: string[];
  skill?: string[];
}

/** `remove [skills...]`: `names` are the positionals. */
async function runRemove(names: string[], opts: RemoveOptions, globalOpts: GlobalOpts): Promise<number> {
  const all = !!opts.all;
  const yes = !!opts.yes || all || isRunningInAgent();
  let selectors = [...names, ...(opts.skill ?? [])];

  try {
    if (opts.global && opts.project) {
      throw new CliError(1, "--global cannot be combined with --project");
    }

    // Global by default. With a skill-library.json here, ask (or take -p / -g). Without a prompt
    // the scope must be explicit: guessing wrong would delete a skill from the whole library.
    let projectScope = !!opts.project;

    if (!projectScope && !opts.global) {
      const project = await loadProject(globalOpts.cwd);

      if (project?.exists) {
        if (yes || !process.stdin.isTTY) {
          throw new CliError(
            1,
            `This folder has a project (${project.file}); say where to remove from.`,
            "Use -p to drop the project's reference, or -g to delete from the global library.",
          );
        }

        const choice = await prompts.select({
          message: "Remove from",
          options: [
            { value: "global", label: "Global", hint: "delete from the library, every project" },
            { value: "project", label: "Project", hint: `only ${project.file}` },
          ],
        });

        if (prompts.isCancel(choice)) {
          prompts.cancel("Removal cancelled");

          return 0;
        }

        projectScope = choice === "project";
      }
    }

    const base = {
      cwd: globalOpts.cwd,
      ...(globalOpts.store ? { store: globalOpts.store } : {}),
      project: projectScope,
    };

    if (all && names.length > 0) {
      throw new CliError(1, "Cannot combine --all with specific skill names.", `Use \`skill-library remove --all\` to remove every skill, or omit --all to remove only the named skills.\n   Example: skill-library remove ${names[0]!} -y`);
    }

    if (!all && selectors.length === 0) {
      if (!process.stdin.isTTY) {
        throw new CliError(1, "Interactive prompt required but stdin is not a TTY. Nothing was removed. Name the skills to remove (or use --all) and -y to run non-interactively.");
      }

      const choices = await removableSkills(base);

      if (choices.length === 0) {
        console.log(pc.gray("No skills found to remove."));

        return 0;
      }

      const picked = await prompts.multiselect({
        message: "Select skills to remove",
        options: choices.map((skill) => ({ value: skill.id, label: skill.name, hint: skill.id })),
        required: true,
      });

      if (prompts.isCancel(picked)) {
        prompts.cancel("Removal cancelled");

        return 0;
      }

      selectors = picked;
    }

    if (!yes && !process.stdin.isTTY) {
      throw new CliError(1, "Interactive prompt required but stdin is not a TTY. Nothing was removed. Use -y to run non-interactively.");
    }

    if (!yes) {
      const what = selectors.join(", ");
      const ok = await prompts.confirm({ message: `Remove ${what}${base.project ? " from this project" : " from the library"}?` });

      if (prompts.isCancel(ok) || !ok) {
        prompts.cancel("Removal cancelled");

        return 0;
      }
    }

    const res = await removeSkills(all ? [] : selectors, {
      ...base,
      all,
      ...(opts.agent ? { agents: opts.agent } : {}),
      ...(process.stdin.isTTY ? { chooseAmbiguous: pickAmbiguous } : {}),
    });

    for (const noteText of res.notes) {
      note(noteText);
    }

    const globalRows = res.removed.filter((row) => row.scope === "global" && row.action !== "kept");

    if (globalRows.length > 0) {
      await afterGlobalChange({ removed: globalRows.filter((row) => row.action === "removed").map((row) => row.id) }, globalOpts);
    }

    if (res.unmatched.length > 0 && res.removed.length === 0) {
      console.log(`No matching skills found for: ${res.unmatched.join(", ")}`);

      return 0;
    }

    const done = res.removed.filter((row) => row.action !== "kept");

    for (const row of res.removed) {
      if (row.action === "kept") {
        console.log(`${pc.yellow("!")} ${String(row.message)}`);
      } else if (row.action === "agents") {
        console.log(`${pc.green("✓")} Updated agents for ${sanitizeMetadata(row.name)}`);
      } else {
        console.log(`${pc.green("✓")} Removed ${sanitizeMetadata(row.name)} ${pc.gray(`(${row.id})`)}`);
      }

      if (row.action !== "kept" && row.message) {
        note(row.message);
      }
    }

    if (done.length > 0) {
      console.log();
      console.log(`Successfully removed ${done.length} skill(s)`);
    }

    console.log("Done!");

    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);

      return err.exitCode;
    }

    throw err;
  }
}

export function removeCommand(ctx: Ctx) {
  return warnUnknownOptions(newCommand("remove"))
    .aliases(["rm", "r"])
    .summary("Remove skills")
    .description(
      "Remove skills from the global library. With -p it only drops this project's reference (the skill stays in the library). "
      + "In a folder with a skill-library.json you are asked which one you mean; without a prompt (-y, no TTY, inside an agent) pass -p or -g. "
      + "Without skill names, an interactive selection menu is shown.",
    )
    .argument("[skills...]", "Skill names or ids to remove")
    .option("-p, --project", "Only drop this project's reference (the skill stays in the library)")
    .option("-g, --global", "Delete from the library itself (the default; skips the scope prompt)")
    .option("-a, --agent <agents...>", "Remove only these agents from the skill's agent list", list)
    .option("-s, --skill <skills...>", "Skills to remove ('*' for all skills)", list)
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--all", "Remove every skill in scope (-y implied). Do not combine with named skills")
    .addHelpText(
      "after",
      examples([
        ["skill-library remove", "interactive selection"],
        ["skill-library remove my-skill", "remove one skill"],
        ["skill-library remove skill1 skill2 -y", "remove several skills"],
        ["skill-library remove -p my-skill", "drop it from this project only"],
        ["skill-library rm --agent claude-code my-skill", "stop offering it to Claude Code"],
        ["skill-library remove --all", "remove every skill"],
      ]),
    )
    .action(async (names, opts) => {
      ctx.done(await runRemove(names, opts, ctx.globals()));
    });
}
