import { parse as parseYaml } from "yaml";

/**
 * Minimal YAML frontmatter parser (port of vercel-labs/skills src/frontmatter.ts, MIT).
 * Only the `---` YAML delimiter is supported; no JS engines.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  if (!match) {
    return { data: {}, content: raw };
  }

  const parsed = parseYaml(match[1]!) as unknown;
  const data = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};

  return { data, content: match[2] ?? "" };
}
