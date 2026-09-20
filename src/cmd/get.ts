import { parseArgs, printJson, type Globals } from "../lib/cli.ts";
import { findEntry, loadIndex, projection } from "../lib/store.ts";

export const help = `skill-library get <id> — print one skill

Output: the record {id,name,description,path,dir}; add --return-content to
include the full SKILL.md text.

Example: skill-library get 9f3a1c2b --return-content`;

export async function run(args: string[], globals: Globals): Promise<void> {
  const { positionals } = parseArgs(args, {
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<id>",
  });
  const index = await loadIndex(globals.store);
  const entry = findEntry(index, positionals[0]!);
  printJson(await projection(entry, globals), globals.pretty);
}
