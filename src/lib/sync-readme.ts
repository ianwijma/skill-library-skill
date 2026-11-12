// The README `sync init` / `sync update` put in a sync repository: what the repo is, how to set it
// up, and a link back to Skill Library. The text lives in assets/sync-readme.md (edit it there);
// `{{title}}` and `{{url}}` are filled in here.
import template from "../../assets/sync-readme.md";

/** A clone URL as a URL: `user@host:path` (scp-style, which URL() rejects) reads as `ssh://user@host/path`. */
function toUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    if (!url.includes(":")) {
      return null;
    }

    try {
      return new URL(`ssh://${url.replace(":", "/")}`);
    } catch {
      return null;
    }
  }
}

/** Host and path segments (without `.git`) of a clone URL; null for local paths and junk. */
function parseRemote(url: string): { host: string; parts: string[] } | null {
  const parsedUrl = toUrl(url);

  if (!parsedUrl || parsedUrl.protocol === "file:" || parsedUrl.hostname === "") {
    return null;
  }

  const parts = decodeURIComponent(parsedUrl.pathname).replace(/\.git\/?$/, "").split("/")
    .filter(Boolean);

  return parts.length === 0 ? null : { host: parsedUrl.hostname.toLowerCase(), parts };
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
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return url;
  }

  const http = parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";

  if (!parsedUrl.password && !parsedUrl.search && !parsedUrl.hash && !(http && parsedUrl.username)) {
    return url;
  }

  if (http) {
    parsedUrl.username = "";
  }

  parsedUrl.password = "";
  parsedUrl.search = "";
  parsedUrl.hash = "";

  return parsedUrl.toString();
}

function fill(url: string, fallbackName?: string | null): string {
  const values: Record<string, string> = { title: readmeTitle(url, fallbackName), url: shareableUrl(url) };

  return template.replace(/\r\n/g, "\n").replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

/** The README for the sync repo at `url` (`fallbackName`: see readmeTitle). */
export function newReadme(url: string, fallbackName?: string | null): string {
  return `${fill(url, fallbackName).replace(/\s*$/, "")}\n`;
}
