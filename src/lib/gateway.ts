import { promises as fsp } from "node:fs";
import path from "node:path";
import gatewayContent from "../../skills/skill-library/SKILL.md";
import { detectInstalledAgents, displayName, globalReadDir } from "./agents.ts";
import { parseFrontmatter } from "./frontmatter.ts";

export const GATEWAY_NAME = "skill-library";
export const OLD_HELPERS = [
  "skill-library-add",
  "skill-library-get",
  "skill-library-list",
  "skill-library-update",
  "skill-library-remove",
  "skill-library-query",
  "skill-importer",
  "skill-importer-undo",
];

export function gatewaySkillMd(): string {
  return gatewayContent;
}

export interface GatewayResult {
  /** Display names of agents whose gateway was written or refreshed. */
  updated: string[];
  /** Old helper skill folders/links removed. */
  removedHelpers: string[];
  /** Non-fatal problems (e.g. read-only dirs). */
  errors: string[];
}

async function lstatOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fsp.lstat(p);
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
  const result: GatewayResult = { updated: [], removedHelpers: [], errors: [] };
  if (process.env.SKILL_LIBRARY_NO_GATEWAY === "1") return result;
  const content = gatewaySkillMd();
  const agents = [...new Set([...(await detectInstalledAgents().catch(() => [] as string[])), ...extraAgents])];
  const byDir = new Map<string, string[]>();
  for (const id of agents) {
    const dir = globalReadDir(id);
    if (!dir) continue;
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
      if (st === null) write = true;
      else if (st.isSymbolicLink()) {
        await fsp.unlink(target); // never follow into the link target
        write = true;
      } else if (st.isDirectory()) {
        const existing = await fsp.readFile(file, "utf8").catch(() => null);
        if (existing === content) write = false;
        else if (existing === null || (await frontmatterName(file)) === GATEWAY_NAME) write = true;
        else result.errors.push(`${file} belongs to another skill; not overwritten`);
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
      for (const helper of OLD_HELPERS) {
        const hp = path.join(dir, helper);
        const hst = await lstatOrNull(hp);
        if (!hst) continue;
        if (hst.isSymbolicLink()) {
          await fsp.unlink(hp);
          result.removedHelpers.push(hp);
        } else if (hst.isDirectory() && (await frontmatterName(path.join(hp, "SKILL.md"))) === helper) {
          await fsp.rm(hp, { recursive: true, force: true });
          result.removedHelpers.push(hp);
        }
      }
    } catch (err) {
      result.errors.push(`${dir}: ${(err as Error).message}`);
    }
  }
  // Canonical vercel copies of the old helpers (~/.agents/skills/<helper>).
  const canonical = globalReadDir("codex");
  if (canonical && !byDir.has(canonical)) {
    for (const helper of OLD_HELPERS) {
      const hp = path.join(canonical, helper);
      const hst = await lstatOrNull(hp);
      if (hst?.isDirectory() && (await frontmatterName(path.join(hp, "SKILL.md"))) === helper) {
        await fsp.rm(hp, { recursive: true, force: true }).catch(() => {});
        result.removedHelpers.push(hp);
      }
    }
  }
  return result;
}
