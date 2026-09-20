import { parseArgs, printJson, requireFlag, validateName, warn, type Globals } from "../lib/cli.ts";
import { generateId } from "../lib/ids.ts";
import { ensureStore } from "../lib/paths.ts";
import {
  loadIndex,
  projection,
  readSourceFile,
  resolveSourceFile,
  saveIndex,
  writeFileAtomic,
  type IndexEntry,
} from "../lib/store.ts";

export const help = `skill-library add — import a skill file into the library

Required flags:
  --name <name>          lowercase-hyphen, at most 64 chars
  --description <text>   what it does + when to use it (this is what gets scored)
  --path <file>          skill file to import (copied verbatim into the store)

The store path of the new skill is printed (not the source path).

Example:
  skill-library add --name context7-mcp --description "Use when questions involve libraries, frameworks, or APIs; fetch current docs via Context7 MCP." --path ~/.agents/skills/context7-mcp/SKILL.md`;

export async function run(args: string[], globals: Globals): Promise<void> {
  const { values } = parseArgs(args, {
    flags: { name: "string", description: "string", path: "string" },
    maxPositionals: 0,
  });
  const name = requireFlag(values, "name");
  const description = requireFlag(values, "description");
  const sourceArg = requireFlag(values, "path");
  validateName(name);

  const source = await resolveSourceFile(sourceArg);
  const content = await readSourceFile(source);

  await ensureStore(globals.store);
  const index = await loadIndex(globals.store);
  if (index.some((e) => e.name === name)) {
    warn(`name '${name}' already exists in the library (ids are unique); proceeding`);
  }
  const id = generateId(index.map((e) => e.id));
  const contentFile = `skills/${id}.md`;
  await writeFileAtomic(`${globals.store}/${contentFile}`, content);

  const now = new Date().toISOString();
  const entry: IndexEntry = {
    id,
    name,
    description,
    source,
    addedAt: now,
    updatedAt: now,
    contentFile,
  };
  await saveIndex(globals.store, [...index, entry]);
  printJson(await projection(entry, globals), globals.pretty);
}
