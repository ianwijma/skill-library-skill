// The README `sync init` puts in a sync repository: a short note on what the repo is and a link
// back to Skill Library. The text lives in assets/sync-readme.md (edit it there); `{{title}}`,
// `{{link}}` and `{{url}}` are filled in here. The part between the markers is "our section":
// it is added to a README the user already has, and a later `sync init` updates it in place
// without touching the rest of their README.
import template from "../../assets/sync-readme.md";

const PROJECT = "https://github.com/ianwijma/skill-library-skill";
export const README_START = "<!-- skill-library:start -->";
export const README_END = "<!-- skill-library:end -->";

/**
 * `owner/repo` (or `host/owner/repo` off GitHub) of a clone URL, for the link's tracking
 * parameters. Credentials, ports and local paths are never included; null when there is no host.
 */
export function repoSlug(url: string): string | null {
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
  if (parts.length === 0) return null;
  const tail = parts.slice(-2).join("/");
  return host.toLowerCase() === "github.com" ? tail : `${host.toLowerCase()}/${tail}`;
}

/** Link to the project, tagged with the sync repo it was clicked from. */
export function projectLink(url: string): string {
  const params = new URLSearchParams({ utm_source: "skill-library-sync", utm_medium: "readme" });
  const slug = repoSlug(url);
  if (slug) params.set("utm_campaign", slug);
  return `${PROJECT}?${params.toString()}`;
}

function fill(url: string): string {
  const slug = repoSlug(url);
  const values: Record<string, string> = {
    title: slug ? slug.split("/").pop()! : "Agent skills",
    link: projectLink(url),
    url,
  };
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

/** A whole README for a repo that has none. */
export function newReadme(url: string): string {
  return `${fill(url).replace(/\s*$/, "")}\n`;
}

export type ReadmePlan = { action: "create" | "add" | "update"; text: string } | { action: "none" };

/** What to do with the README `current` (null: no README) so it carries the current section. */
export function planReadme(current: string | null, url: string): ReadmePlan {
  if (current === null) return { action: "create", text: newReadme(url) };
  const section = readmeSection(url);
  const start = current.indexOf(README_START);
  const end = start === -1 ? -1 : current.indexOf(README_END, start);
  if (start === -1 || end === -1) {
    return { action: "add", text: `${current.replace(/\s*$/, "")}\n\n${section}\n` };
  }
  const next = current.slice(0, start) + section + current.slice(end + README_END.length);
  return next === current ? { action: "none" } : { action: "update", text: next };
}
