import type { ComponentType } from "react";
import type { AgentDefinition } from "./config.js";
import type { HomeSkillFile } from "./home-skill-migration.js";
import { AGENT_FOLDER_SKILL_MODULE, createSkillRoutes, type SkillMeta, type SkillModule } from "./routing.js";
import type { DiscoveredAgent } from "./agent.node.js";

/**
 * A bundled agent registry: the static import graph `curb build` generates in place of
 * filesystem discovery.
 *
 * The shape is what `generateAgentModulesCode` (`bundler/agent-modules.ts`) emits. Keys are
 * `./agent/<relative path>`.
 */
export type BundledAgentRegistry = {
  agentModules: Record<string, { agent?: AgentDefinition }>;
  agentSources: Record<string, string>;
  skillModules: Record<string, { default?: ComponentType; meta?: SkillMeta }>;
  skillSources: Record<string, string>;
};

let bundled: BundledAgentRegistry | undefined;

/**
 * Install a bundled registry, making filesystem discovery unnecessary.
 *
 * A hosted artifact has no `src/agent/` to walk and no TypeScript loader to import
 * `.tsx` with, so the readdirSync + dynamic import path cannot work there. The registry
 * carries the same modules as real static imports the bundler could follow.
 *
 * Called by the generated worker entry before anything reads an agent. Nothing else
 * should call it: two registries in one process would make "which agent is running"
 * depend on import order.
 */
export function setBundledAgentRegistry(registry: BundledAgentRegistry): void {
  if (bundled !== undefined) {
    throw new Error(
      "curb: a bundled agent registry is already installed. " +
        "Installing a second one would make the running agent depend on import order.",
    );
  }
  bundled = registry;
}

/** The installed registry, or undefined when running from a checkout. */
export function bundledAgentRegistry(): BundledAgentRegistry | undefined {
  return bundled;
}

/**
 * Build a DiscoveredAgent from the bundled registry.
 *
 * Deliberately mirrors `discoverAgent` rather than sharing a code path with it: that
 * one is inherently filesystem-shaped (walk, import by URL, read source), and forcing
 * one function to serve both would leave the hosted path carrying a filesystem
 * abstraction it can never satisfy.
 */
export function discoverAgentFromRegistry(id = "agent"): DiscoveredAgent {
  const registry = bundled;
  if (!registry) {
    throw new Error("curb: no bundled agent registry is installed.");
  }

  const agentKey = Object.keys(registry.agentModules)[0];
  if (!agentKey) {
    throw new Error(
      "curb: the bundled registry contains no agent module. " +
        "The artifact was built from a project with no src/agent/agent.tsx.",
    );
  }

  const definition = registry.agentModules[agentKey]?.agent;
  if (!definition) {
    throw new Error(
      `curb: bundled agent module "${agentKey}" does not export \`agent\`. ` +
        "It must export the result of defineAgent(...).",
    );
  }

  const modules: Record<string, SkillModule> = {};
  let homeSkill: HomeSkillFile | undefined;
  for (const [key, module] of Object.entries(registry.skillModules)) {
    // Registry keys are PROJECT-relative ("./agent/claim-status/skill.tsx") while
    // createSkillRoutes derives route paths from AGENT-DIR-relative keys. Passing them
    // through unchanged yields routes like "/agent/claim-status", which no <Skill> link
    // names, so the model could never open a skill.
    const normalized = key.replace(/\\/g, "/").match(/^\.\/agent\/(.*)$/);
    if (!normalized) {
      throw new Error(
        `curb: bundled skill key "${key}" is not of the form "./agent/<path>/skill.tsx".`,
      );
    }
    const moduleId = `./${normalized[1]}`;
    // Source travels in the registry rather than being read from disk: authoring
    // surfaces show it, and a hosted artifact has no .tsx to read.
    const source = registry.skillSources[key] ?? "";
    // The agent folder's own skill.tsx is not a skill: kept as text for the diagnostic
    // that fails the build's render check, as filesystem discovery does.
    if (moduleId === AGENT_FOLDER_SKILL_MODULE) {
      homeSkill = { moduleId, source };
      continue;
    }
    if (typeof module.default !== "function") {
      throw new Error(`curb: bundled skill module "${key}" must default-export a React component.`);
    }
    modules[moduleId] = { default: module.default, meta: module.meta, source };
  }

  return {
    id,
    definition,
    routes: createSkillRoutes(modules),
    source: registry.agentSources[agentKey] ?? "",
    diagnostics: [],
    ...(homeSkill ? { homeSkill } : {}),
  };
}
