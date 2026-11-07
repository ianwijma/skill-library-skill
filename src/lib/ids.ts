import { homedir } from "node:os";
import path from "node:path";
import { sha256Hex } from "./hash.ts";
import { isInside, toPosix } from "./paths.ts";

export const ID_PREFIXES = ["repo://", "local://", "home://", "path://"] as const;

/** The gateway's own name and its namespace; never stored. */
export function isReservedSkillName(name: string): boolean {
  return name === "skill-library" || name.startsWith("skill-library-");
}

export function isId(value: string): boolean {
  return ID_PREFIXES.some((p) => value.startsWith(p));
}

/** Host and repository path of a git URL, normalised for ids (scheme, user, port, `.git` dropped). */
export function gitRepoKey(url: string): { host: string; repoPath: string } {
  let host = "";
  let repoPath = "";
  const scp = url.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const u = new URL(url);
    host = u.protocol === "file:" ? "localhost" : u.hostname;
    repoPath = decodeURIComponent(u.pathname);
  } else if (scp) {
    host = scp[1]!;
    repoPath = scp[2]!;
  } else {
    repoPath = url;
  }
  host = host.toLowerCase();
  repoPath = repoPath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (host === "github.com") repoPath = repoPath.toLowerCase();
  return { host, repoPath };
}

export function gitSkillId(url: string, skillName: string): string {
  const { host, repoPath } = gitRepoKey(url);
  return `repo://${host}/${repoPath}/${skillName}`;
}

/**
 * Id of a skill read from the local filesystem.
 * `projectRoot` is set only for project-scope adds: folders inside it get `local://` ids.
 */
export function localSkillId(absPath: string, projectRoot: string | null): string {
  if (projectRoot !== null && isInside(projectRoot, absPath)) {
    const rel = toPosix(path.relative(projectRoot, absPath));
    return `local://${rel === "" ? "." : rel}`;
  }
  const home = homedir();
  if (isInside(home, absPath) && path.resolve(absPath) !== path.resolve(home)) {
    return `home://${toPosix(path.relative(home, absPath))}`;
  }
  return `path://${toPosix(path.resolve(absPath))}`;
}

/** Filesystem-safe folder name for a skill, independent of its id. */
export function safeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return slug === "" ? "skill" : slug;
}

export function skillDirFor(id: string, name: string): string {
  return `skills/${safeSlug(name)}-${sha256Hex(id).slice(0, 8)}`;
}
