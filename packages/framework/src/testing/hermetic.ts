import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMcpManager } from "../mcp/manager.js";
import { resolveProjectRoot } from "../project.node.js";
import type { AgentSiteRuntime } from "../runtime.js";
import type { ToolResult } from "../types.js";

/**
 * What makes a test call hermetic, and the check every call makes of its fakes: a fake for a tool
 * the agent does not have is an error before the first turn, not a note after the real tool ran.
 */

/**
 * The fakes of `names` that stand in for no tool of the agent on `runtime`, each as a problem
 * naming the tools it has. A tool counts when the agent shows it now, when a skill shows it on a
 * fresh copy of the agent (`skillCatalog`), or when the agent's code names it in quotes (a tool
 * shown only in some state, such as after a check passed). A tool of an MCP server that is not
 * connected cannot be known, so its fake is taken as it is.
 */
export function unknownFakeProblems(runtime: AgentSiteRuntime, names: readonly string[], projectRoot = resolveProjectRoot()): string[] {
  if (names.length === 0) return [];
  const known = new Set(runtime.snapshot().context.tools.map((tool) => tool.name));
  const catalog = runtime.skillCatalog();
  for (const tool of catalog.tools) known.add(tool.name);
  for (const skill of catalog.skills) for (const tool of skill.tools) known.add(tool.name);
  const missing = names.filter((name) => !known.has(name) && !ofUnreadyMcpServer(name));
  if (missing.length === 0) return [];
  const named = namedInAgentCode(projectRoot, missing);
  const has = [...known].filter((name) => !FRAMEWORK_TOOL_NAMES.has(name)).sort();
  return missing
    .filter((name) => !named.has(name))
    .map(
      (name) =>
        `[CURB_TEST_UNKNOWN_FAKE] fakes.${name}: the agent has no tool "${name}" (it has ${has.length > 0 ? has.map((tool) => `"${tool}"`).join(", ") : "none"}), so the fake would stand in for nothing. ` +
        "Fix: give the fake the name of one of these tools, or remove it.",
    );
}

const FRAMEWORK_TOOL_NAMES = new Set(["read_skill", "skip_turn", "end_call"]);

/** Whether `name` is a tool of an MCP server (`<server>__<tool>`) whose tools are not known now. */
function ofUnreadyMcpServer(name: string): boolean {
  const manager = getMcpManager();
  return manager.serverIds().some((id) => name.startsWith(`${id}__`) && manager.resolve(id).status !== "ready");
}

/** Which of `names` the agent's code (`src/agent/`, its tests and scenarios left out) names in quotes. */
function namedInAgentCode(projectRoot: string, names: readonly string[]): Set<string> {
  const found = new Set<string>();
  const dir = join(projectRoot, "src", "agent");
  if (!existsSync(dir)) return found;
  const files: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry.name) && !/\.(scenario|test|spec)\.[^.]+$/.test(entry.name)) files.push(path);
    }
  };
  walk(dir);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const name of names) {
      if (!found.has(name) && [`"${name}"`, `'${name}'`, `\`${name}\``].some((quoted) => text.includes(quoted))) found.add(name);
    }
  }
  return found;
}

/** The MCP servers whose tools a hermetic call cannot offer: each as the problem its state names. */
export function missingMcpSnapshots(): string[] {
  const manager = getMcpManager();
  return manager.serverIds().flatMap((id) => {
    const state = manager.resolve(id);
    return state.status === "error" && state.message.startsWith("[MCP_TOOLS_MISSING]") ? [state.message] : [];
  });
}

/** Why a hermetic call stopped at a call of `tool`, which has no fake. */
export function unfakedToolMessage(tool: string): string {
  return (
    `[CURB_TEST_UNFAKED_TOOL] hermetic: the agent called "${tool}", which has no fake, so the run stopped before the tool ran. ` +
    `Fix: fake it (fakes: { ${tool}: { ok: true, message: "..." } }), or leave hermetic off for this run.`
  );
}

/** The result the transcript holds for that call: the model never reads it, the turn stops. */
export function unfakedToolResult(tool: string): ToolResult {
  return { ok: false, message: `${tool} did not run: this hermetic test has no fake for it.` };
}
