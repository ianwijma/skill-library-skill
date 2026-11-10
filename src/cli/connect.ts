// `connect`: install the skill-library gateway skill into your agents, so they know to query.
import { agentIds, displayName, globalReadDir, detectInstalledAgents } from "../lib/agents.ts";
import { CliError, DIM, RESET, TEXT } from "../lib/cli.ts";
import { GATEWAY_NAME, writeGateway } from "../lib/gateway.ts";
import { validateAgents } from "../core/context.ts";
import { parseFlags } from "./args.ts";
import type { GlobalOpts } from "./index.ts";

export async function runConnect(args: string[], g: GlobalOpts): Promise<number> {
  const f = parseFlags(args, { booleans: { json: ["--json"] }, lists: { agent: ["-a", "--agent"] } });
  const json = f.booleans.has("json");
  if (f.missing.length > 0) throw new CliError(1, `${f.missing[0]} requires a value`);
  if (f.positionals.length > 0) throw new CliError(1, `Unexpected argument: ${f.positionals[0]}`, "Usage: skill-library connect [-a <agents>]");

  const requested = f.lists.get("agent");
  let agents: string[];
  if (requested && requested.length > 0) {
    if (requested.includes("*")) throw new CliError(1, "Invalid agents: *", `Name the agents to connect. Valid agents: ${agentIds().join(", ")}`);
    validateAgents(requested);
    agents = [...new Set(requested)];
    const noGlobal = agents.filter((id) => !globalReadDir(id));
    if (noGlobal.length > 0) throw new CliError(1, `${noGlobal.map(displayName).join(", ")} has no global skills folder`);
  } else {
    agents = (await detectInstalledAgents(g.cwd)).filter((id) => globalReadDir(id));
    if (agents.length === 0) {
      throw new CliError(1, "No agents found on this machine", "Name them with -a, e.g. skill-library connect -a claude-code");
    }
  }

  const result = await writeGateway(agents);
  if (json) {
    console.log(JSON.stringify({ updated: result.updated, current: result.current, errors: result.errors }, null, 2));
    return result.errors.length > 0 ? 1 : 0;
  }
  for (const e of result.errors) console.error(`Error: ${e}`);
  if (result.updated.length > 0) {
    console.log(`${TEXT}Installed the ${GATEWAY_NAME} skill for ${result.updated.join(", ")}${RESET}`);
  }
  if (result.current.length > 0) {
    console.log(`${DIM}Already up to date for ${result.current.join(", ")}${RESET}`);
  }
  if (result.updated.length > 0) {
    console.log(`${DIM}Restart your agent so it loads the skill.${RESET}`);
  }
  return result.errors.length > 0 ? 1 : 0;
}
