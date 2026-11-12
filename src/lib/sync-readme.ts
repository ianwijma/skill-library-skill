// The README `sync init` puts in a sync repository: a short note on what the repo is and a link
// back to Skill Library. The text lives in assets/sync-readme.md (edit it there); `{{title}}`
// and `{{url}}` are filled in here. The part between the markers is "our section":
// it is added to a README the user already has, and a later `sync init` updates it in place
// without touching the rest of their README.
import template from "../../assets/sync-readme.md";

export const README_START = "<!-- skill-library:start -->";
export const README_END = "<!-- skill-library:end -->";

/** Host and path segments (without `.git`) of a clone URL; null for local paths and junk. */
function parseRemote(url: string): { host: string; parts: string[] } | null {
  let host: string;
  let pathname: string;
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(url); // git@github.com:me/skills.git
  if (scp) {
    host = scp[1]!;
    pathname = scp[2]!;
  } else {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol === "file:" || u.hostname === "") return null;
    host = u.hostname;
    pathname = u.pathname;
  }
  const parts = pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  return parts.length === 0 ? null : { host: host.toLowerCase(), parts };
}

/** The user or organization a clone URL belongs to (`me` of `git@github.com:me/skills.git`), or null. */
export function repoOwner(url: string): string | null {
  const parts = parseRemote(url)?.parts ?? [];
  return parts.length >= 2 ? parts[parts.length - 2]! : null;
}

/** "<owner>'s Skills", from the repo URL's owner, else `fallbackName` (git user.name), else "My Skills". */
export function readmeTitle(url: string, fallbackName?: string | null): string {
  const owner = repoOwner(url) ?? fallbackName?.trim();
  return owner ? `${owner}'s Skills` : "My Skills";
}

/**
 * The clone URL as it may appear in a committed README: no password or token. HTTP(S) URLs lose
 * their whole user part (a token is often the user name) and their query and fragment; ssh:// URLs
 * keep the user (e.g. `git@`) but lose any password. `user@host:path` and local paths are as given.
 */
export function shareableUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const http = u.protocol === "http:" || u.protocol === "https:";
  if (!u.password && !u.search && !u.hash && !(http && u.username)) return url;
  if (http) u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  return u.toString();
}

function fill(url: string, fallbackName?: string | null): string {
  const values: Record<string, string> = { title: readmeTitle(url, fallbackName), url: shareableUrl(url) };
  return template.replace(/\r\n/g, "\n").replace(/\{\{(\w+)\}\}/g, (m, key: string) => values[key] ?? m);
}

/** The marker-delimited section (no trailing newline). */
export function readmeSection(url: string): string {
  const text = fill(url);
  const start = text.indexOf(README_START);
  const end = text.indexOf(README_END, start);
  if (start === -1 || end === -1) throw new Error("assets/sync-readme.md is missing the skill-library markers");
  return text.slice(start, end + README_END.length);
}

/** A whole README for a repo that has none (`fallbackName`: see readmeTitle). */
export function newReadme(url: string, fallbackName?: string | null): string {
  return `${fill(url, fallbackName).replace(/\s*$/, "")}\n`;
}

export type ReadmePlan = { action: "create" | "add" | "update"; text: string } | { action: "none" };

/** What to do with the README `current` (null: no README) so it carries the current section. */
export function planReadme(current: string | null, url: string, fallbackName?: string | null): ReadmePlan {
  if (current === null) return { action: "create", text: newReadme(url, fallbackName) };
  // Everything outside the section stays byte-for-byte; the section follows the file's line endings.
  const nl = current.includes("\r\n") ? "\r\n" : "\n";
  const section = readmeSection(url).replace(/\n/g, nl);
  const start = current.indexOf(README_START);
  const end = start === -1 ? -1 : current.indexOf(README_END, start);
  if (start === -1 || end === -1) {
    const sep = current === "" ? "" : current.endsWith(`${nl}${nl}`) ? "" : current.endsWith(nl) ? nl : `${nl}${nl}`;
    return { action: "add", text: `${current}${sep}${section}${nl}` };
  }
  const next = current.slice(0, start) + section + current.slice(end + README_END.length);
  return next === current ? { action: "none" } : { action: "update", text: next };
}
