import { promises as fsp } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import gatewayContent from "../../skills/skill-library/SKILL.md";
import { agentIds, detectInstalledAgents, displayName, globalReadDir } from "./agents.ts";
import { parseFrontmatter } from "./frontmatter.ts";

export const GATEWAY_NAME = "skill-library";

export function gatewaySkillMd(): string {
  return gatewayContent;
}

export interface GatewayResult {
  /** Display names of agents whose gateway was written or refreshed. */
  updated: string[];
  /** Display names of agents whose gateway was already up to date. */
  current: string[];
  /** Non-fatal problems (e.g. read-only dirs). */
  errors: string[];
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(filePath);
  } catch {
    return null;
  }
}

async function frontmatterName(file: string): Promise<string | null> {
  try {
    const { data } = parseFrontmatter(await fsp.readFile(file, "utf8"));

    return typeof data.name === "string" ? data.name : null;
  } catch {
    return null;
  }
}

/**
 * Place (or refresh) the gateway in the global skills dir of every installed agent plus
 * `extraAgents`, grouped by physical dir. Never throws; failures are reported in `errors`.
 */
export async function placeGateway(extraAgents: string[] = []): Promise<GatewayResult> {
  if (process.env.SKILL_LIBRARY_NO_GATEWAY === "1") {
    return { updated: [], current: [], errors: [] };
  }

  return writeGateway([...(await detectInstalledAgents().catch(() => [] as string[])), ...extraAgents]);
}

/**
 * Write (or refresh) the gateway in the global skills dir of exactly these agents, grouped by
 * physical dir. Agents without a global skills dir are skipped. Never throws.
 */
export async function writeGateway(targetAgentIds: string[]): Promise<GatewayResult> {
  const result: GatewayResult = { updated: [], current: [], errors: [] };
  const content = gatewaySkillMd();
  const agents = [...new Set(targetAgentIds)];
  const byDir = new Map<string, string[]>();

  for (const id of agents) {
    const dir = globalReadDir(id);

    if (!dir) {
      continue;
    }

    let key = path.resolve(dir);

    try {
      key = await fsp.realpath(dir);
    } catch {
      // not created yet
    }

    byDir.set(key, [...(byDir.get(key) ?? []), id]);
  }

  for (const [dir, ids] of byDir) {
    try {
      const target = path.join(dir, GATEWAY_NAME);
      const file = path.join(target, "SKILL.md");
      const st = await lstatOrNull(target);
      let write = false;

      if (st === null) {
        write = true;
      } else if (st.isSymbolicLink()) {
        await fsp.unlink(target); // never follow into the link target
        write = true;
      } else if (st.isDirectory()) {
        const existing = await fsp.readFile(file, "utf8").catch(() => null);

        if (existing === content) {
          result.current.push(...ids.map(displayName));
        } else if (existing === null || (await frontmatterName(file)) === GATEWAY_NAME) {
          write = true;
        } else {
          result.errors.push(`${file} belongs to another skill; not overwritten`);
        }
      } else {
        result.errors.push(`${target} is not a directory; not overwritten`);
      }

      if (write) {
        await fsp.mkdir(target, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;

        await fsp.writeFile(tmp, content, "utf8");
        await fsp.rename(tmp, file);
        result.updated.push(...ids.map(displayName));
      }
    } catch (err) {
      result.errors.push(`${dir}: ${(err as Error).message}`);
    }
  }

  return result;
}

export type GatewayState = "current" | "outdated" | "missing";

/** Is this agent's gateway installed, and is it this version's? Null for agents without a global skills dir. */
export async function gatewayState(agentId: string): Promise<GatewayState | null> {
  const dir = globalReadDir(agentId);

  if (!dir) {
    return null;
  }

  const file = path.join(dir, GATEWAY_NAME, "SKILL.md");
  const existing = await fsp.readFile(file, "utf8").catch(() => null);

  if (existing === null || (await frontmatterName(file)) !== GATEWAY_NAME) {
    return "missing";
  }

  return existing === gatewaySkillMd() ? "current" : "outdated";
}

/** Every agent whose global skills dir already holds the gateway (any version). */
export async function agentsWithGateway(): Promise<string[]> {
  const out: string[] = [];

  for (const id of agentIds()) {
    const state = await gatewayState(id);

    if (state === "current" || state === "outdated") {
      out.push(id);
    }
  }

  return out;
}
