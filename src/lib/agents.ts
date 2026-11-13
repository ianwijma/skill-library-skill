// Agent registry ported from vercel-labs/skills v1.7.6 (src/agents.ts), MIT License,
// Copyright (c) 2026 Vercel, Inc. See ThirdPartyNotices.txt.
// Changes: the table is built lazily from the current environment (so tests can point HOME
// elsewhere), xdg-basedir is replaced by $XDG_CONFIG_HOME, and the Eve/subagent helpers are dropped.
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface AgentConfig {
  name: string;
  displayName: string;
  skillsDir: string;
  /** Global skills directory; undefined when the agent has no global skills. */
  globalSkillsDir: string | undefined;
  detectInstalled: (cwd?: string) => Promise<boolean>;
  showInUniversalList?: boolean;
  showInUniversalPrompt?: boolean;
  globalReadsCanonical?: boolean;
  createProjectSkillsDirByDefault?: boolean;
}

let cache: Record<string, AgentConfig> | undefined;

/** The agent table, keyed by agent id (the valid `-a` values). */
export function getAgents(): Record<string, AgentConfig> {
  cache ??= buildAgents();

  return cache;
}

/** Forget the cached table (tests change HOME between cases). */
export function resetAgents(): void {
  cache = undefined;
}

export function agentIds(): string[] {
  return Object.keys(getAgents());
}

export function displayName(id: string): string {
  return getAgents()[id]?.displayName ?? id;
}

/** The global dir an agent actually reads skills from (vercel: universal agents read ~/.agents/skills). */
export function globalReadDir(id: string): string | undefined {
  const agent = getAgents()[id];

  if (!agent) {
    return undefined;
  }

  if (
    agent.skillsDir === ".agents/skills"
    && agent.globalReadsCanonical !== false
    && agent.globalSkillsDir !== undefined
  ) {
    return join(homedir(), ".agents", "skills");
  }

  return agent.globalSkillsDir;
}

export async function detectInstalledAgents(cwd: string = process.cwd()): Promise<string[]> {
  const entries = Object.entries(getAgents());
  const results = await Promise.all(
    entries.map(async ([id, agent]) => ({ id, ok: await agent.detectInstalled(cwd).catch(() => false) })),
  );

  return results.filter((result) => result.ok).map((result) => result.id);
}

function buildAgents(): Record<string, AgentConfig> {
  const home = homedir();
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const vibeHome = process.env.VIBE_HOME?.trim() || join(home, ".vibe");
  const hermesHome = process.env.HERMES_HOME?.trim() || join(home, ".hermes");
  const autohandHome = process.env.AUTOHAND_HOME?.trim() || join(home, ".autohand");
  const grokHome = process.env.GROK_HOME?.trim() || join(home, ".grok");
  const sarvamHome = process.env.SARVAM_HOME?.trim() || join(home, ".sarvam");
  const appDataHome = process.env.APPDATA?.trim() || join(home, "AppData", "Roaming");
  const reasonixDefault = platform() === "win32" ? join(appDataHome, "reasonix") : join(home, ".reasonix");
  const reasonixHome = process.env.REASONIX_HOME?.trim() || reasonixDefault;
  const zedAppDataHome = process.env.APPDATA?.trim();
  const zedFlatpakConfigHome = process.env.FLATPAK_XDG_CONFIG_HOME?.trim();

  function packageJsonHasDependency(packageJsonPath: string, dependencyName: string): boolean {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };

      return !!(pkg.dependencies?.[dependencyName] || pkg.devDependencies?.[dependencyName]);
    } catch {
      return false;
    }
  }

  function getOpenClawGlobalSkillsDir(): string {
    if (existsSync(join(home, ".openclaw"))) {
      return join(home, ".openclaw/skills");
    }

    if (existsSync(join(home, ".clawdbot"))) {
      return join(home, ".clawdbot/skills");
    }

    if (existsSync(join(home, ".moltbot"))) {
      return join(home, ".moltbot/skills");
    }

    return join(home, ".openclaw/skills");
  }

  const isZCodeInstalled = () => existsSync(join(home, ".zcode")) || existsSync("/Applications/ZCode.app");
  const isKimchiInstalled = () => existsSync(join(home, ".config", "kimchi"));
  const isMiniMaxCodeInstalled = () => existsSync(join(home, ".minimax")) || existsSync("/Applications/MiniMax Code.app");
  const isPositAssistantInstalled = () => existsSync(join(home, ".posit/assistant")) || existsSync(join(home, ".positai"));

  return {
    "aider-desk": {
      name: "aider-desk",
      displayName: "AiderDesk",
      skillsDir: ".aider-desk/skills",
      globalSkillsDir: join(home, ".aider-desk/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".aider-desk"));
      },
    },
    amp: {
      name: "amp",
      displayName: "Amp",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(configHome, "agents/skills"),
      detectInstalled: async () => {
        return existsSync(join(configHome, "amp"));
      },
    },
    antigravity: {
      name: "antigravity",
      displayName: "Antigravity",
      skillsDir: ".agents/skills",
      // agy, the IDE and Antigravity 2.0 read global skills from ~/.gemini/config/skills,
      // and none of them reads ~/.agents/skills outside a workspace.
      globalSkillsDir: join(home, ".gemini/config/skills"),
      globalReadsCanonical: false,
      showInUniversalPrompt: false,
      detectInstalled: async () => {
        return existsSync(join(home, ".gemini/antigravity"));
      },
    },
    "antigravity-cli": {
      name: "antigravity-cli",
      displayName: "Antigravity CLI",
      skillsDir: ".agents/skills",
      // agy, the IDE and Antigravity 2.0 read global skills from ~/.gemini/config/skills,
      // and none of them reads ~/.agents/skills outside a workspace.
      globalSkillsDir: join(home, ".gemini/config/skills"),
      globalReadsCanonical: false,
      showInUniversalPrompt: false,
      detectInstalled: async () => {
        return existsSync(join(home, ".gemini/antigravity-cli"));
      },
    },
    astrbot: {
      name: "astrbot",
      displayName: "AstrBot",
      skillsDir: "data/skills",
      globalSkillsDir: join(home, ".astrbot/data/skills"),
      detectInstalled: async (cwd = process.cwd()) => {
        return existsSync(join(cwd, "data/skills")) || existsSync(join(home, ".astrbot"));
      },
    },
    "autohand-code": {
      name: "autohand-code",
      displayName: "Autohand Code CLI",
      skillsDir: ".autohand/skills",
      globalSkillsDir: join(autohandHome, "skills"),
      detectInstalled: async () => {
        return existsSync(autohandHome);
      },
    },
    augment: {
      name: "augment",
      displayName: "Augment",
      skillsDir: ".augment/skills",
      globalSkillsDir: join(home, ".augment/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".augment"));
      },
    },
    bob: {
      name: "bob",
      displayName: "IBM Bob",
      skillsDir: ".bob/skills",
      globalSkillsDir: join(home, ".bob/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".bob"));
      },
    },
    "claude-code": {
      name: "claude-code",
      displayName: "Claude Code",
      skillsDir: ".claude/skills",
      globalSkillsDir: join(claudeHome, "skills"),
      // Preserve the established project-install behavior from #1138 and #1607.
      createProjectSkillsDirByDefault: true,
      detectInstalled: async () => {
        return existsSync(claudeHome);
      },
    },
    openclaw: {
      name: "openclaw",
      displayName: "OpenClaw",
      skillsDir: "skills",
      globalSkillsDir: getOpenClawGlobalSkillsDir(),
      detectInstalled: async () => {
        return (
          existsSync(join(home, ".openclaw"))
          || existsSync(join(home, ".clawdbot"))
          || existsSync(join(home, ".moltbot"))
        );
      },
    },
    cline: {
      name: "cline",
      displayName: "Cline",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents", "skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".cline"));
      },
    },
    "codearts-agent": {
      name: "codearts-agent",
      displayName: "CodeArts Agent",
      skillsDir: ".codeartsdoer/skills",
      globalSkillsDir: join(home, ".codeartsdoer/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".codeartsdoer"));
      },
    },
    codebuddy: {
      name: "codebuddy",
      displayName: "CodeBuddy",
      skillsDir: ".codebuddy/skills",
      globalSkillsDir: join(home, ".codebuddy/skills"),
      detectInstalled: async (cwd = process.cwd()) => {
        return existsSync(join(cwd, ".codebuddy")) || existsSync(join(home, ".codebuddy"));
      },
    },
    codemaker: {
      name: "codemaker",
      displayName: "Codemaker",
      skillsDir: ".codemaker/skills",
      globalSkillsDir: join(home, ".codemaker/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".codemaker"));
      },
    },
    codestudio: {
      name: "codestudio",
      displayName: "Code Studio",
      skillsDir: ".codestudio/skills",
      globalSkillsDir: join(home, ".codestudio/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".codestudio"));
      },
    },
    codex: {
      name: "codex",
      displayName: "Codex",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents", "skills"),
      detectInstalled: async () => {
        return existsSync(codexHome) || existsSync("/etc/codex");
      },
    },
    "command-code": {
      name: "command-code",
      displayName: "Command Code",
      skillsDir: ".commandcode/skills",
      globalSkillsDir: join(home, ".commandcode/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".commandcode"));
      },
    },
    continue: {
      name: "continue",
      displayName: "Continue",
      skillsDir: ".continue/skills",
      globalSkillsDir: join(home, ".continue/skills"),
      detectInstalled: async (cwd = process.cwd()) => {
        return existsSync(join(cwd, ".continue")) || existsSync(join(home, ".continue"));
      },
    },
    cortex: {
      name: "cortex",
      displayName: "Cortex Code",
      skillsDir: ".cortex/skills",
      globalSkillsDir: join(home, ".snowflake/cortex/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".snowflake/cortex"));
      },
    },
    crush: {
      name: "crush",
      displayName: "Crush",
      skillsDir: ".crush/skills",
      globalSkillsDir: join(home, ".config/crush/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".config/crush"));
      },
    },
    cursor: {
      name: "cursor",
      displayName: "Cursor",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".cursor/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".cursor"));
      },
    },
    deepagents: {
      name: "deepagents",
      displayName: "Deep Agents",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".deepagents/agent/skills"),
      showInUniversalPrompt: false,
      detectInstalled: async () => {
        return existsSync(join(home, ".deepagents"));
      },
    },
    devin: {
      name: "devin",
      displayName: "Devin for Terminal",
      skillsDir: ".devin/skills",
      globalSkillsDir: join(configHome, "devin/skills"),
      detectInstalled: async () => {
        return existsSync(join(configHome, "devin"));
      },
    },
    dexto: {
      name: "dexto",
      displayName: "Dexto",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents/skills"),
      showInUniversalPrompt: false,
      detectInstalled: async () => {
        return existsSync(join(home, ".dexto"));
      },
    },
    droid: {
      name: "droid",
      displayName: "Droid",
      // Droid reads .agents/skills and ~/.agents/skills as compatibility
      // locations, so installing there avoids defining the same skill twice.
      // globalSkillsDir stays on ~/.factory/skills so `remove` still cleans up
      // skills placed there by earlier versions.
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".factory/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".factory"));
      },
    },
    eve: {
      name: "eve",
      displayName: "Eve",
      skillsDir: "agent/skills",
      globalSkillsDir: undefined,
      detectInstalled: async (cwd = process.cwd()) => {
        return (
          existsSync(join(cwd, "agent")) && packageJsonHasDependency(join(cwd, "package.json"), "eve")
        );
      },
    },
    firebender: {
      name: "firebender",
      displayName: "Firebender",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".firebender/skills"),
      showInUniversalPrompt: false,
      detectInstalled: async () => {
        return existsSync(join(home, ".firebender"));
      },
    },
    forgecode: {
      name: "forgecode",
      displayName: "ForgeCode",
      skillsDir: ".forge/skills",
      globalSkillsDir: join(home, ".forge/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".forge"));
      },
    },
    fx: {
      name: "fx",
      displayName: "fx",
      // fx discovers these shared roots natively alongside its own .fx/skills roots.
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".fx"));
      },
    },
    "gemini-cli": {
      name: "gemini-cli",
      displayName: "Gemini CLI",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".gemini/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".gemini"));
      },
    },
    "github-copilot": {
      name: "github-copilot",
      displayName: "GitHub Copilot",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".copilot/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".copilot"));
      },
    },
    goose: {
      name: "goose",
      displayName: "Goose",
      skillsDir: ".goose/skills",
      globalSkillsDir: join(configHome, "goose/skills"),
      detectInstalled: async () => {
        return existsSync(join(configHome, "goose"));
      },
    },
    grok: {
      name: "grok",
      displayName: "Grok Build",
      skillsDir: ".grok/skills",
      globalSkillsDir: join(grokHome, "skills"),
      detectInstalled: async () => {
        return existsSync(grokHome);
      },
    },
    "hermes-agent": {
      name: "hermes-agent",
      displayName: "Hermes Agent",
      skillsDir: ".hermes/skills",
      globalSkillsDir: join(hermesHome, "skills"),
      detectInstalled: async () => {
        return existsSync(hermesHome);
      },
    },
    "inference-sh": {
      name: "inference-sh",
      displayName: "inference.sh",
      skillsDir: ".inferencesh/skills",
      globalSkillsDir: join(home, ".inferencesh/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".inferencesh"));
      },
    },
    jazz: {
      name: "jazz",
      displayName: "Jazz",
      skillsDir: ".jazz/skills",
      globalSkillsDir: join(home, ".jazz/skills"),
      detectInstalled: async (cwd = process.cwd()) => {
        return existsSync(join(home, ".jazz")) || existsSync(join(cwd, ".jazz"));
      },
    },
    junie: {
      name: "junie",
      displayName: "Junie",
      skillsDir: ".junie/skills",
      globalSkillsDir: join(home, ".junie/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".junie"));
      },
    },
    "iflow-cli": {
      name: "iflow-cli",
      displayName: "iFlow CLI",
      skillsDir: ".iflow/skills",
      globalSkillsDir: join(home, ".iflow/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".iflow"));
      },
    },
    kilo: {
      name: "kilo",
      displayName: "Kilo Code",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".kilo/skills"),
      detectInstalled: async () => {
      // `.kilocode` is the legacy config directory, kept here so existing
      // installs are still detected.
        return existsSync(join(home, ".kilo")) || existsSync(join(home, ".kilocode"));
      },
    },
    kimchi: {
      name: "kimchi",
      displayName: "Kimchi",
      skillsDir: ".kimchi/skills",
      globalSkillsDir: join(home, ".config", "kimchi", "harness", "skills"),
      detectInstalled: async () => {
        return isKimchiInstalled();
      },
    },
    "kimi-code-cli": {
      name: "kimi-code-cli",
      displayName: "Kimi Code CLI",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".kimi-code")) || existsSync(join(home, ".kimi"));
      },
    },
    "kiro-cli": {
      name: "kiro-cli",
      displayName: "Kiro CLI",
      skillsDir: ".kiro/skills",
      globalSkillsDir: join(home, ".kiro/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".kiro"));
      },
    },
    kode: {
      name: "kode",
      displayName: "Kode",
      skillsDir: ".kode/skills",
      globalSkillsDir: join(home, ".kode/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".kode"));
      },
    },
    lingma: {
      name: "lingma",
      displayName: "Lingma",
      skillsDir: ".lingma/skills",
      globalSkillsDir: join(home, ".lingma/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".lingma"));
      },
    },
    loaf: {
      name: "loaf",
      displayName: "Loaf",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents/skills"),
      showInUniversalPrompt: false,
      detectInstalled: async () => {
        return existsSync(join(home, ".loaf"));
      },
    },
    mcpjam: {
      name: "mcpjam",
      displayName: "MCPJam",
      skillsDir: ".mcpjam/skills",
      globalSkillsDir: join(home, ".mcpjam/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".mcpjam"));
      },
    },
    "minimax-code": {
      name: "minimax-code",
      displayName: "MiniMax Code",
      skillsDir: ".minimax/skills",
      globalSkillsDir: join(home, ".minimax/skills"),
      detectInstalled: async () => {
        return isMiniMaxCodeInstalled();
      },
    },
    "mistral-vibe": {
      name: "mistral-vibe",
      displayName: "Mistral Vibe",
      skillsDir: ".vibe/skills",
      globalSkillsDir: join(vibeHome, "skills"),
      detectInstalled: async () => {
        return existsSync(vibeHome);
      },
    },
    moxby: {
      name: "moxby",
      displayName: "Moxby",
      skillsDir: ".moxby/skills",
      globalSkillsDir: join(home, ".moxby/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".moxby"));
      },
    },
    mux: {
      name: "mux",
      displayName: "Mux",
      skillsDir: ".mux/skills",
      globalSkillsDir: join(home, ".mux/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".mux"));
      },
    },
    opencode: {
      name: "opencode",
      displayName: "OpenCode",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(configHome, "opencode/skills"),
      detectInstalled: async () => {
        return existsSync(join(configHome, "opencode"));
      },
    },
    openhands: {
      name: "openhands",
      displayName: "OpenHands",
      skillsDir: ".openhands/skills",
      globalSkillsDir: join(home, ".openhands/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".openhands"));
      },
    },
    ona: {
      name: "ona",
      displayName: "Ona",
      skillsDir: ".ona/skills",
      globalSkillsDir: join(home, ".ona/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".ona"));
      },
    },
    pi: {
      name: "pi",
      displayName: "Pi",
      // Pi natively reads the Agent Skills locations: `.agents/skills/` from the working
      // directory up through its ancestors, and `~/.agents/skills/` globally.
      // See https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".pi/agent"));
      },
    },
    "posit-assistant": {
      name: "posit-assistant",
      displayName: "Posit Assistant",
      skillsDir: ".posit/assistant/skills",
      globalSkillsDir: join(home, ".posit/assistant/skills"),
      detectInstalled: async () => {
        return isPositAssistantInstalled();
      },
    },
    qoder: {
      name: "qoder",
      displayName: "Qoder",
      skillsDir: ".qoder/skills",
      globalSkillsDir: join(home, ".qoder/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".qoder"));
      },
    },
    "qoder-cn": {
      name: "qoder-cn",
      displayName: "Qoder CN",
      skillsDir: ".qoder/skills",
      globalSkillsDir: join(home, ".qoder-cn/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".qoder-cn"));
      },
    },
    "qwen-code": {
      name: "qwen-code",
      displayName: "Qwen Code",
      skillsDir: ".qwen/skills",
      globalSkillsDir: join(home, ".qwen/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".qwen"));
      },
    },
    replit: {
      name: "replit",
      displayName: "Replit",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(configHome, "agents/skills"),
      showInUniversalList: false,
      detectInstalled: async (cwd = process.cwd()) => {
        return existsSync(join(cwd, ".replit"));
      },
    },
    reasonix: {
      name: "reasonix",
      displayName: "Reasonix",
      skillsDir: ".reasonix/skills",
      globalSkillsDir: join(reasonixHome, "skills"),
      detectInstalled: async () => {
        return existsSync(reasonixHome);
      },
    },
    rovodev: {
      name: "rovodev",
      displayName: "Rovo Dev",
      skillsDir: ".rovodev/skills",
      globalSkillsDir: join(home, ".rovodev/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".rovodev"));
      },
    },
    roo: {
      name: "roo",
      displayName: "Roo Code",
      skillsDir: ".roo/skills",
      globalSkillsDir: join(home, ".roo/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".roo"));
      },
    },
    "sarvam-code": {
      name: "sarvam-code",
      displayName: "Sarvam Code",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents/skills"),
      showInUniversalPrompt: false,
      detectInstalled: async () => {
        return existsSync(sarvamHome);
      },
    },
    "tabnine-cli": {
      name: "tabnine-cli",
      displayName: "Tabnine CLI",
      skillsDir: ".tabnine/agent/skills",
      globalSkillsDir: join(home, ".tabnine/agent/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".tabnine"));
      },
    },
    terramind: {
      name: "terramind",
      displayName: "Terramind",
      skillsDir: ".terramind/skills",
      globalSkillsDir: join(home, ".terramind/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".terramind"));
      },
    },
    tinycloud: {
      name: "tinycloud",
      displayName: "Tinycloud",
      skillsDir: ".tinycloud/skills",
      globalSkillsDir: join(home, ".tinycloud/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".tinycloud"));
      },
    },
    trae: {
      name: "trae",
      displayName: "Trae",
      skillsDir: ".trae/skills",
      globalSkillsDir: join(home, ".trae/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".trae"));
      },
    },
    "trae-cn": {
      name: "trae-cn",
      displayName: "Trae CN",
      skillsDir: ".trae/skills",
      globalSkillsDir: join(home, ".trae-cn/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".trae-cn"));
      },
    },
    warp: {
      name: "warp",
      displayName: "Warp",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".warp"));
      },
    },
    windsurf: {
      name: "windsurf",
      displayName: "Windsurf",
      skillsDir: ".windsurf/skills",
      globalSkillsDir: join(home, ".codeium/windsurf/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".codeium/windsurf"));
      },
    },
    zed: {
      name: "zed",
      displayName: "Zed",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(home, ".agents/skills"),
      detectInstalled: async () => {
      // Per Zed's config_dir() in crates/paths/src/paths.rs.
        return (
          existsSync(join(configHome, "zed"))
          || (!!zedAppDataHome && existsSync(join(zedAppDataHome, "Zed")))
          || (!!zedFlatpakConfigHome && existsSync(join(zedFlatpakConfigHome, "zed")))
        );
      },
    },
    zcode: {
      name: "zcode",
      displayName: "ZCode",
      skillsDir: ".zcode/skills",
      globalSkillsDir: join(home, ".zcode/skills"),
      detectInstalled: async () => {
        return isZCodeInstalled();
      },
    },
    zencoder: {
      name: "zencoder",
      displayName: "Zencoder",
      skillsDir: ".zencoder/skills",
      globalSkillsDir: join(home, ".zencoder/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".zencoder"));
      },
    },
    zenflow: {
      name: "zenflow",
      displayName: "Zenflow",
      skillsDir: ".zencoder/skills",
      globalSkillsDir: join(home, ".zencoder/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".zencoder"));
      },
    },
    neovate: {
      name: "neovate",
      displayName: "Neovate",
      skillsDir: ".neovate/skills",
      globalSkillsDir: join(home, ".neovate/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".neovate"));
      },
    },
    pochi: {
      name: "pochi",
      displayName: "Pochi",
      skillsDir: ".pochi/skills",
      globalSkillsDir: join(home, ".pochi/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".pochi"));
      },
    },
    promptscript: {
      name: "promptscript",
      displayName: "PromptScript",
      skillsDir: ".agents/skills",
      globalSkillsDir: undefined,
      showInUniversalPrompt: false,
      detectInstalled: async (cwd = process.cwd()) => {
        return existsSync(join(cwd, ".promptscript")) || existsSync(join(cwd, "promptscript.yaml"));
      },
    },
    adal: {
      name: "adal",
      displayName: "AdaL",
      skillsDir: ".adal/skills",
      globalSkillsDir: join(home, ".adal/skills"),
      detectInstalled: async () => {
        return existsSync(join(home, ".adal"));
      },
    },
    universal: {
      name: "universal",
      displayName: "Universal",
      skillsDir: ".agents/skills",
      globalSkillsDir: join(configHome, "agents/skills"),
      showInUniversalList: false,
      detectInstalled: async () => false,
    },
  };
}
