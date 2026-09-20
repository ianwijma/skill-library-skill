import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CliError, msgOf } from "./cli.ts";

export function resolveStore(flagStore?: string): string {
  const raw = flagStore ?? process.env.SKILL_LIBRARY_DIR ?? defaultStoreDir();
  return path.resolve(raw);
}

function defaultStoreDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(dataHome, "skill-library");
}

export function indexPath(store: string): string {
  return path.join(store, "index.json");
}

export function skillsDir(store: string): string {
  return path.join(store, "skills");
}

export function skillDirPath(store: string, contentDir: string): string {
  return path.resolve(store, contentDir);
}

export function entryFilePath(store: string, contentDir: string): string {
  return path.join(skillDirPath(store, contentDir), "SKILL.md");
}

export async function ensureStore(store: string): Promise<void> {
  try {
    await fsp.mkdir(skillsDir(store), { recursive: true });
  } catch (err) {
    throw new CliError(2, `cannot create store directory ${store}: ${msgOf(err)}`);
  }
}
