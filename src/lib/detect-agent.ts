// Agent detection: a port of the environment checks in @vercel/detect-agent (Apache-2.0/MIT,
// Vercel, Inc.) plus vercel-labs/skills' Cursor refinement (src/detect-agent.ts, MIT).
// No dependency: only environment variables (and Devin's marker file) are inspected.
import { existsSync } from "node:fs";

export interface DetectedAgent {
  /** detect-agent name, e.g. "claude", "codex", "cursor-cli". */
  name: string;
  /** Matching skill-library agent id, when there is one. */
  agentId: string | null;
}

const NAME_TO_AGENT: Record<string, string> = {
  cursor: "cursor",
  "cursor-cli": "cursor",
  claude: "claude-code",
  cowork: "claude-code",
  devin: "devin",
  replit: "replit",
  gemini: "gemini-cli",
  codex: "codex",
  antigravity: "antigravity",
  "augment-cli": "augment",
  opencode: "opencode",
  "github-copilot": "github-copilot",
};

function has(name: string): boolean {
  const value = process.env[name];

  return value !== undefined && value.trim() !== "";
}

function rawDetect(): string | null {
  const ai = process.env.AI_AGENT?.trim();

  if (ai) {
    return ai.toLowerCase();
  }

  if (has("CURSOR_TRACE_ID")) {
    return "cursor";
  }

  if (has("CURSOR_AGENT")) {
    return "cursor-cli";
  }

  if (has("GEMINI_CLI")) {
    return "gemini";
  }

  if (has("CODEX_SANDBOX") || has("CODEX_CI") || has("CODEX_THREAD_ID")) {
    return "codex";
  }

  if (has("ANTIGRAVITY_AGENT")) {
    return "antigravity";
  }

  if (has("AUGMENT_AGENT")) {
    return "augment-cli";
  }

  if (has("OPENCODE_CLIENT")) {
    return "opencode";
  }

  if (has("CLAUDECODE") || has("CLAUDE_CODE")) {
    return has("CLAUDE_CODE_IS_COWORK") ? "cowork" : "claude";
  }

  if (has("REPL_ID")) {
    return "replit";
  }

  if (has("COPILOT_MODEL") || has("COPILOT_ALLOW_ALL") || has("COPILOT_GITHUB_TOKEN")) {
    return "github-copilot";
  }

  if (existsSync("/opt/.devin")) {
    return "devin";
  }

  return null;
}

let cached: DetectedAgent | null | undefined;

/** Detect whether the CLI runs inside an AI agent (cached per process). */
export function detectAgent(): DetectedAgent | null {
  if (cached !== undefined) {
    return cached;
  }

  let name = rawDetect();

  // CURSOR_TRACE_ID is also set in Cursor's integrated terminal for normal users.
  if (name === "cursor" || name === "cursor-cli") {
    const strong = has("CURSOR_AGENT") || process.env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec";

    name = strong ? "cursor-cli" : null;
  }

  cached = name ? { name, agentId: NAME_TO_AGENT[name] ?? null } : null;

  return cached;
}

export function isRunningInAgent(): boolean {
  return detectAgent() !== null;
}
