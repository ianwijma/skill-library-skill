import { parseArgs, printJson, requireFlag, validateName, warn, type Globals } from "../lib/cli.ts";
import { generateId } from "../lib/ids.ts";
import { ensureStore } from "../lib/paths.ts";
import {
  commitSkillDir,
  loadIndex,
  projection,
  resolveSource,
  saveIndex,
  stageSkillDir,
  type IndexEntry,
} from "../lib/store.ts";

export const help = `skill-library add — import a skill into the library

Required flags:
  --name <name>          lowercase-hyphen, at most 64 chars
  --description <text>   what it does + when to use it (this is what gets scored)
  --path <file|dir>      skill file or skill directory to import

A directory import copies the whole skill folder verbatim (SKILL.md plus any
sibling scripts/data), so relative references keep working. A bare SKILL.md
file is copied as a single-file skill. The store path of the new skill is
printed (not the source path).

Example:
  skill-library add --name context7-mcp --description "Use when questions involve libraries, frameworks, or APIs; fetch current docs via Context7 MCP." --path ~/.agents/skills/context7-mcp`;

export async function run(args: string[], globals: Globals): Promise<void> {
  const { values } = parseArgs(args, {
    flags: { name: "string", description: "string", path: "string" },
    maxPositionals: 0,
  });
  const name = requireFlag(values, "name");
  const description = requireFlag(values, "description");
  const sourceArg = requireFlag(values, "path");
  validateName(name);

  const source = await resolveSource(sourceArg);

  await ensureStore(globals.store);
  const index = await loadIndex(globals.store);
  if (index.some((e) => e.name === name)) {
    warn(`name '${name}' already exists in the library (ids are unique); proceeding`);
  }
  const id = generateId(index.map((e) => e.id));
  const contentDir = await stageSkillDir(source, globals.store, id);
  await commitSkillDir(globals.store, contentDir);

  const now = new Date().toISOString();
  const entry: IndexEntry = {
    id,
    name,
    description,
    source: source.abs,
    addedAt: now,
    updatedAt: now,
    contentDir,
  };
  await saveIndex(globals.store, [...index, entry]);
  printJson(await projection(entry, globals), globals.pretty);
}
