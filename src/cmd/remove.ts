import { parseArgs, printJson, warn, type Globals } from "../lib/cli.ts";
import {
  findEntry,
  listSkillFiles,
  loadIndex,
  readContent,
  removeSkillDir,
  saveIndex,
} from "../lib/store.ts";

export const help = `skill-library remove <id> — delete a skill from the library

Prints the deleted record including its SKILL.md content and the list of
imported files, so it stays recoverable from the transcript.

Example: skill-library remove 9f3a1c2b`;

export async function run(args: string[], globals: Globals): Promise<void> {
  const { positionals } = parseArgs(args, {
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<id>",
  });
  const id = positionals[0]!;

  const index = await loadIndex(globals.store);
  const entry = findEntry(index, id);
  const content = await readContent(globals.store, entry);
  if (content === undefined) {
    warn(`SKILL.md missing for '${entry.name}' (${entry.id}); removing record anyway`);
  }
  const files = await listSkillFiles(globals.store, entry);

  await saveIndex(globals.store, index.filter((e) => e.id !== id));
  await removeSkillDir(globals.store, entry.contentDir);

  const deleted: Record<string, unknown> = { id: entry.id, name: entry.name, description: entry.description };
  if (content !== undefined) deleted.content = content;
  deleted.files = files;
  printJson(deleted, globals.pretty);
}
