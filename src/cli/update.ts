import pc from "picocolors";
import { checkSkills, updateSkills, type UpdateRow } from "../core/update.ts";
import { builtinNote, isBuiltinName } from "../lib/builtin.ts";
import { CliError, formatError, note, sanitizeMetadata } from "../lib/cli.ts";
import { pickAmbiguous } from "./remove.ts";
import { afterGlobalChange } from "./sync/shared.ts";
import { type Ctx, examples, newCommand, warnUnknownOptions } from "./command.ts";
import type { GlobalOpts } from "./index.ts";

interface UpdateOptions {
  global?: boolean;
  project?: boolean;
  /** Accepted; update never prompts for anything but an ambiguous name. */
  yes?: boolean;
}

/** `update` / `check [skills...]`: `names` are the positionals. */
async function runUpdate(names: string[], flags: UpdateOptions, globalOpts: GlobalOpts, mode: "update" | "check"): Promise<number> {
  const opts = {
    cwd: globalOpts.cwd,
    ...(globalOpts.store ? { store: globalOpts.store } : {}),
    global: !!flags.global,
    project: !!flags.project,
    skills: names,
    ...(process.stdin.isTTY ? { chooseAmbiguous: pickAmbiguous } : {}),
  };

  try {
    const res = mode === "check" ? await checkSkills(opts) : await updateSkills(opts);

    // Built-in skills ship with skill-library; a library skill with the same name is updated as usual.
    for (const name of names) {
      if (isBuiltinName(name) && !res.skills.some((skill) => skill.name === name)) {
        note(builtinNote(name));
      }
    }

    const label = res.scopes.map((scope) => (scope === "global" ? "global" : "project")).join(" and ");

    if (res.skills.length === 0) {
      console.log(pc.gray(`No ${label} skills to ${mode === "check" ? "check" : "update"}.`));

      return 0;
    }

    console.log(pc.gray(`${mode === "check" ? "Checking" : "Updating"} ${label} skills…`));
    const skipped: UpdateRow[] = [];

    for (const skill of res.skills) {
      const name = sanitizeMetadata(skill.name);

      if (skill.status === "has-update") {
        console.log(`  ${pc.yellow("↑")} ${name} has an update`);
      } else if (skill.status === "updated") {
        console.log(`  ${pc.green("✓")} Updated ${name}${skill.from ? ` ${pc.gray(`${skill.from} → ${String(skill.to)}`)}` : ""}`);
      } else if (skill.status === "up-to-date") {
        console.log(`  ${pc.dim("•")} ${name} is up to date`);
      } else if (skill.status === "failed") {
        console.log(`  ${pc.red("✗")} ${name}: ${String(skill.reason)}`);
      } else {
        skipped.push(skill);
      }
    }

    if (skipped.length > 0) {
      console.log();
      console.log(pc.gray("Skipped:"));

      for (const skill of skipped) {
        console.log(`  ${sanitizeMetadata(skill.name)} ${pc.gray(`(${String(skill.reason)})`)}`);
      }

      if (skipped.some((skill) => skill.reason === "Local path")) {
        console.log(pc.gray("To update a local skill: skill-library add <path>"));
      }
    }

    const failed = res.skills.some((skill) => skill.status === "failed");

    if (mode === "update" && res.skills.some((skill) => skill.scope === "global" && skill.status === "updated")) {
      await afterGlobalChange({}, globalOpts);
    }

    if (mode === "check") {
      const count = res.skills.filter((skill) => skill.status === "has-update").length;

      console.log();
      console.log(count > 0 ? `${count} skill(s) have updates. Run skill-library update to apply them.` : "All skills are up to date.");

      return count > 0 || failed ? 1 : 0;
    }

    return failed ? 1 : 0;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${formatError(err)}`);

      return 1;
    }

    throw err;
  }
}

/** `update` and `check` take the same arguments and options. */
export function updateLikeCommand(ctx: Ctx, mode: "update" | "check") {
  const verb = mode === "update" ? "Update" : "Check";

  return warnUnknownOptions(newCommand(mode))
    .argument("[skills...]", `Skills to ${mode} (default: all in scope)`)
    .option("-g, --global", `${verb} global skills only`)
    .option("-p, --project", `${verb} project skills only`)
    .option("-y, --yes", "Skip prompts (scope: project if it has skills, else global)")
    .addHelpText("after", examples([[`skill-library ${mode}`], [`skill-library ${mode} -g`, "global skills only"], [`skill-library ${mode} my-skill`]]))
    .action(async (names, opts) => {
      ctx.done(await runUpdate(names, opts, ctx.globals(), mode));
    });
}

export function updateCommand(ctx: Ctx) {
  return updateLikeCommand(ctx, "update").alias("upgrade").description("Update skills from their source");
}
