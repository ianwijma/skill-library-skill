import { homedir } from "node:os";
import path from "node:path";

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

export function lockPath(store: string): string {
  return path.join(store, "index.lock");
}

export function skillsRoot(store: string): string {
  return path.join(store, "skills");
}

/** Expand a leading "~/" to the home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Collapse a path under the home directory to "~/…" (portable form for manifests). */
export function tildify(p: string): string {
  const home = homedir();
  const rel = path.relative(home, p);
  if (rel === "") return "~";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return `~/${rel.split(path.sep).join("/")}`;
  return p;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
