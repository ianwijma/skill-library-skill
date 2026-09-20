import { promises as fsp } from "node:fs";
import { parseArgs, printJson, warn, type Globals } from "../lib/cli.ts";
import { skillsDir } from "../lib/paths.ts";
import { loadIndex, projection } from "../lib/store.ts";

export const help = `skill-library list — print the catalog

Output: {"skills":[{id,name,description,path,dir}...]} sorted by name ascending.
This is the diff source for rerunnable imports.

Example: skill-library list --return-content`;

export async function run(args: string[], globals: Globals): Promise<void> {
  parseArgs(args, { maxPositionals: 0 });
  const index = (await loadIndex(globals.store)).sort(byName);
  await warnOrphans(globals.store, index);
  const skills = [];
  for (const entry of index) skills.push(await projection(entry, globals));
  printJson({ skills }, globals.pretty);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function warnOrphans(store: string, index: { contentDir: string }[]): Promise<void> {
  let files: string[];
  try {
    files = await fsp.readdir(skillsDir(store));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    throw err;
  }
  const known = new Set(index.map((e) => e.contentDir.replace(/^skills\//, "")));
  const orphans = files.filter((f) => !known.has(f));
  if (orphans.length > 0) {
    warn(`orphaned content dir(s) ignored by the library: ${orphans.join(", ")}`);
  }
}
