// `self`: commands that look after skill-library itself, rather than your skills.
import { CliError } from "../../lib/cli.ts";
import { type Ctx, examples, newCommand, subcommandOptions, withSubcommands } from "../command.ts";
import { doctorCommand } from "./doctor.ts";
import { setupCommand } from "./setup.ts";
import { updateCommand } from "./update.ts";

export function selfCommand(ctx: Ctx) {
  const self = newCommand("self")
    .usage("<command> [options]")
    .summary("Set up, update and check skill-library itself")
    .description("Commands that look after skill-library itself, rather than your skills.")
    .addCommand(setupCommand(ctx))
    .addCommand(updateCommand(ctx))
    .addCommand(doctorCommand(ctx));

  self
    .addHelpText("after", subcommandOptions(self))
    .addHelpText("after", examples([["npx skill-library self setup", "start here"], ["skill-library self setup -a claude-code codex", "only these agents"], ["skill-library self doctor --json"]]));
  withSubcommands(self, ctx, (rest) => {
    if (rest.length === 0 || rest[0] === "help") {
      self.outputHelp();

      return 0;
    }

    throw new CliError(1, `Unknown self command: ${rest[0]!}`, "Run skill-library self for the list.");
  });

  return self;
}
