// Source parsing: the subset of vercel-labs/skills v1.7.6 src/source-parser.ts (MIT) that
// skill-library 0.1.0 supports — GitHub shorthand/URLs, generic git URLs and local paths.
// Other forms vercel accepts (well-known endpoints, archives, GitLab /-/tree/ URLs) are
// recognised and rejected with a clear "not supported yet" error instead of being misparsed.
import { isAbsolute, resolve } from "node:path";
import { CliError } from "./cli.ts";

export interface ParsedSource {
  type: "git" | "local";
  /** Clone URL (git) or absolute path (local). */
  url: string;
  ref?: string;
  subpath?: string;
  skillFilter?: string;
}

export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function isVersionPin(value: string): boolean {
  return /^v?\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) || isCommitSha(value);
}

function isLocalPath(input: string): boolean {
  return (
    isAbsolute(input)
    || input.startsWith("./")
    || input.startsWith("../")
    || input === "."
    || input === ".."
    || /^[a-zA-Z]:[/\\]/.test(input)
  );
}

function sanitizeSubpath(subpath: string): string {
  for (const segment of subpath.replace(/\\/g, "/").split("/")) {
    if (segment === "..") {
      throw new CliError(1, `Unsafe subpath: ${subpath}`);
    }
  }

  return subpath;
}

const SOURCE_ALIASES: Record<string, string> = {
  "coinbase/agentWallet": "coinbase/agentic-wallet-skills",
};

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeGitSource(input: string): boolean {
  if (/^(github:|gitlab:|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(input)) {
    return true;
  }

  if (/^https?:\/\//.test(input)) {
    return true;
  }

  return !input.includes(":") && !input.startsWith(".") && !input.startsWith("/") && /^([^/]+)\/([^/]+)(?:\/(.+)|@(.+))?$/.test(input);
}

function parseFragment(input: string): { rest: string; ref?: string; skillFilter?: string } {
  const hashIndex = input.indexOf("#");

  if (hashIndex < 0) {
    return { rest: input };
  }

  const rest = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);

  if (!fragment || !looksLikeGitSource(rest)) {
    return { rest: input };
  }

  const at = fragment.indexOf("@");

  if (at === -1) {
    return { rest, ref: decode(fragment) };
  }

  const ref = fragment.slice(0, at);
  const skill = fragment.slice(at + 1);

  return { rest, ...(ref ? { ref: decode(ref) } : {}), ...(skill ? { skillFilter: decode(skill) } : {}) };
}

function unsupported(input: string, what: string): never {
  throw new CliError(1, `${what} sources are not supported by skill-library yet: ${input}`);
}

export function parseSource(input: string, cwd: string = process.cwd()): ParsedSource {
  if (isLocalPath(input)) {
    return { type: "local", url: resolve(cwd, input) };
  }

  const frag = parseFragment(input);
  let rest = SOURCE_ALIASES[frag.rest] ?? frag.rest;
  const fragRef = frag.ref;
  const fragSkill = frag.skillFilter;
  const withFrag = (parsed: ParsedSource): ParsedSource => ({
    ...parsed,
    ...(parsed.ref === undefined && fragRef ? { ref: fragRef } : {}),
    ...(parsed.skillFilter === undefined && fragSkill ? { skillFilter: fragSkill } : {}),
  });

  const gh = rest.match(/^github:(.+)$/);

  if (gh) {
    return withFrag(parseSource(gh[1]!, cwd));
  }

  const gl = rest.match(/^gitlab:(.+)$/);

  if (gl) {
    rest = `https://gitlab.com/${gl[1]!}`;
  }

  if (/^https?:\/\//.test(rest)) {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(rest);
    } catch {
      throw new CliError(1, `Invalid source URL: ${input}`);
    }

    const host = parsedUrl.hostname.toLowerCase();

    if (host === "raw.githubusercontent.com" || host === "codeload.github.com" || host === "objects.githubusercontent.com") {
      unsupported(input, "Download");
    }

    if (host === "github.com") {
      if (/^\/[^/]+\/[^/]+\/(?:archive\/|raw\/|releases\/)/.test(parsedUrl.pathname)) {
        unsupported(input, "Download");
      }

      const tree = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+?))?\/?$/);

      if (tree) {
        const [, owner, repo, ref, sub] = tree;

        return withFrag({
          type: "git",
          url: `https://github.com/${owner!}/${repo!.replace(/\.git$/, "")}.git`,
          ref: ref!,
          ...(sub ? { subpath: sanitizeSubpath(decode(sub)) } : {}),
        });
      }

      const repo = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);

      if (repo) {
        return withFrag({ type: "git", url: `https://github.com/${repo[1]!}/${repo[2]!}.git` });
      }

      throw new CliError(1, `Unrecognised GitHub URL: ${input}`);
    }

    if (/\/-\/(?:tree|archive|raw)\//.test(parsedUrl.pathname)) {
      unsupported(input, "GitLab tree/archive URL");
    }

    if (host === "gitlab.com") {
      const repoPath = parsedUrl.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");

      if (repoPath.includes("/")) {
        return withFrag({ type: "git", url: `https://gitlab.com/${repoPath}.git` });
      }
    }

    if (/\.git(?:$|[/?])/i.test(rest) || parsedUrl.pathname.split("/").includes("_git")) {
      return withFrag({ type: "git", url: rest });
    }

    unsupported(input, "Well-known / download");
  }

  if (/^(git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(rest)) {
    const sshTree = rest.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+))?$/);

    if (sshTree) {
      const [, host, owner, repo, ref, sub] = sshTree;

      return withFrag({
        type: "git",
        url: `git@${host!}:${owner!}/${repo!}.git`,
        ref: ref!,
        ...(sub ? { subpath: sanitizeSubpath(sub) } : {}),
      });
    }

    if (/^ext::/i.test(rest)) {
      throw new CliError(1, "Unsupported git transport: ext");
    }

    return withFrag({ type: "git", url: rest });
  }

  const at = rest.match(/^([^/]+)\/([^/@]+)@(.+)$/);

  if (at && !rest.includes(":") && !rest.startsWith(".") && !rest.startsWith("/")) {
    const [, owner, repo, sel] = at;
    const url = `https://github.com/${owner!}/${repo!}.git`;

    if (!fragRef && !fragSkill && isVersionPin(sel!)) {
      return { type: "git", url, ref: sel! };
    }

    return withFrag({ type: "git", url, skillFilter: fragSkill || sel! });
  }

  const short = rest.match(/^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/);

  if (short && !rest.includes(":") && !rest.startsWith(".") && !rest.startsWith("/")) {
    const [, owner, repo, sub] = short;

    return withFrag({
      type: "git",
      url: `https://github.com/${owner!}/${repo!}.git`,
      ...(sub ? { subpath: sanitizeSubpath(sub) } : {}),
    });
  }

  if (/^[a-z0-9-]+$/i.test(rest)) {
    throw new CliError(1, `Unrecognised source: ${input}`, "Use owner/repo, a git URL or a local path (./path).");
  }

  return withFrag({ type: "git", url: rest });
}
