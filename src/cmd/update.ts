import { CliError, parseArgs, printJson, validateName, warn, type Globals } from "../lib/cli.ts";
import { contentFilePath } from "../lib/paths.ts";
import {
  findEntry,
  loadIndex,
  projection,
  readSourceFile,
  resolveSourceFile,
  saveIndex,
  writeFileAtomic,
} from "../lib/store.ts";

export const help = `skill-library update <id> — update a skill's name, description, or content

The id never changes; only provided flags change.

  --name <name>          rename
  --description <text>   rewrite the description
  --path <file>          re-import content (replaces the stored file)

Examples:
  skill-library update 9f3a1c2b --description "Rewritten description front-loading trigger keywords."
  skill-library update 9f3a1c2b --path ~/.opencode/skills/frontend-design/SKILL.md`;

export async function run(args: string[], globals: Globals): Promise<void> {
  const { positionals, values } = parseArgs(args, {
    flags: { name: "string", description: "string", path: "string" },
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<id>",
  });
  const id = positionals[0]!;
  if (values.size === 0) {
    throw new CliError(1, "nothing to update — pass --name, --description, or --path");
  }

  const index = await loadIndex(globals.store);
  const entry = { ...findEntry(index, id) };

  if (values.has("name")) {
    const name = values.get("name")!;
    validateName(name);
    if (index.some((e) => e.id !== id && e.name === name)) {
      warn(`name '${name}' already exists in the library (ids are unique); proceeding`);
    }
    entry.name = name;
  }
  if (values.has("description")) {
    entry.description = values.get("description")!;
  }
  if (values.has("path")) {
    const source = await resolveSourceFile(values.get("path")!);
    const content = await readSourceFile(source);
    await writeFileAtomic(contentFilePath(globals.store, entry.contentFile), content);
    entry.source = source;
  }

  entry.updatedAt = new Date().toISOString();
  const next = index.map((e) => (e.id === id ? entry : e));
  await saveIndex(globals.store, next);
  printJson(await projection(entry, globals), globals.pretty);
}
