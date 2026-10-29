import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComponentType } from "react";
import type { HomeSkillFile } from "./home-skill-migration.js";
import {
  AGENT_FOLDER_SKILL_MODULE,
  createSkillRoutes,
  type AgentRoute,
  type SkillMeta,
  type SkillModule,
} from "./routing.js";

/**
 * Walks the agent directory for `skill.*` modules and imports them dynamically,
 * so Node hosts (WS server, voice host) discover skills from the filesystem
 * instead of a hand-maintained static list. The module keys are normalized to
 * `./<dir>/skill.tsx`, the shape of the registry `curb build` bundles, so both
 * derive identical paths (guarded by a drift test in `server/bootstrap.test.ts`).
 * Every skill lives in a folder of its own: the agent folder's own `skill.tsx` is
 * not one (see {@link readHomeSkillFile}).
 */
export async function discoverSkillRoutes(agentDir: string): Promise<AgentRoute[]> {
  const modules: Record<string, SkillModule> = {};
  for (const { file, key } of findSkillModules(agentDir, "")) {
    const module = (await import(pathToFileURL(file).href)) as {
      default?: ComponentType;
      meta?: SkillMeta;
    };
    if (typeof module.default !== "function") {
      throw new Error(`Skill module "${file}" must default-export a React component.`);
    }
    modules[key] = {
      default: module.default,
      meta: module.meta,
      source: readFileSync(file, "utf8"),
    };
  }
  return createSkillRoutes(modules);
}

/**
 * The agent folder's own `skill.tsx` of a project from before the agent level, as text; undefined
 * when there is none. It is read, never imported: nothing in it runs, and `curb check` says where
 * its content goes.
 */
export function readHomeSkillFile(agentDir: string): HomeSkillFile | undefined {
  const entry = readdirSync(agentDir, { withFileTypes: true }).find(
    (candidate) => candidate.isFile() && SKILL_FILE_PATTERN.test(candidate.name),
  );
  if (!entry) return undefined;
  return { moduleId: AGENT_FOLDER_SKILL_MODULE, source: readFileSync(join(agentDir, entry.name), "utf8") };
}

/** Matches source (tsx/ts) and compiled (js) skill modules. */
const SKILL_FILE_PATTERN = /^skill\.(tsx|ts|jsx|js)$/;

function findSkillModules(
  dir: string,
  relative: string,
): Array<{ file: string; key: string }> {
  const found: Array<{ file: string; key: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...findSkillModules(join(dir, entry.name), `${relative}${entry.name}/`));
      continue;
    }
    // The agent folder's own skill file is not a skill (readHomeSkillFile).
    if (relative === "" || !SKILL_FILE_PATTERN.test(entry.name)) continue;
    found.push({
      file: join(dir, entry.name),
      // Extension is normalized so compiled output (skill.js) still produces
      // the same registry keys as the bundled registry over sources (skill.tsx).
      key: `./${relative}skill.tsx`,
    });
  }
  return found;
}
