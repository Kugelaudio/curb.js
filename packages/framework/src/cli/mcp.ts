import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMcpManager, mcpTokenEnvVar, type McpManager } from "../mcp/manager.js";
import { formatMcpToolsSnapshot, MCP_TOOLS_FILE, mcpToolsSnapshot } from "../mcp/snapshot.js";
import type { McpToolInfo } from "../mcp/to-tool-definition.js";

export const MCP_USAGE = `Usage: curb mcp snapshot

Connects to every MCP server of the agent (its mcpServers, the servers added in curb dev, and
every <Mcp url> a skill renders) and writes the tools each one lists, with their names,
descriptions and input schemas, to ${MCP_TOOLS_FILE} at the project root.

Commit the file. A hermetic test run (curb test --hermetic, or a scenario's hermetic: true)
offers MCP tools from it and never connects to a server, so it runs with no network, no
sign-in and no token. Run the command again when a server's tools change.

Exit code 0 when every server listed its tools (or the agent has none); 1, with nothing
written, when a server did not, naming it and what to do.`;

/** The commands `curb mcp` takes, as public-api.txt lists them. */
export const MCP_COMMANDS: readonly string[] = ["snapshot"];

/** How long the command waits for the servers to answer, at most. */
export const MCP_SNAPSHOT_TIMEOUT_MS = 30_000;

/** What the servers of `manager` list now: the snapshot of the ready ones, and why each other one is not. */
export function snapshotMcpServers(manager: McpManager): { servers: Record<string, McpToolInfo[]>; problems: string[]; skipped: string[] } {
  const servers: Record<string, McpToolInfo[]> = {};
  const problems: string[] = [];
  const skipped: string[] = [];
  for (const id of [...manager.serverIds()].sort()) {
    const state = manager.resolve(id);
    if (state.status === "ready") servers[id] = state.tools;
    else if (state.status === "disconnected" || state.status === "absent") skipped.push(id);
    else if (state.status === "error") problems.push(state.message);
    else if (state.status === "auth_required") {
      problems.push(
        `MCP server "${id}" needs a sign-in. Fix: sign in to it in the preview of \`npx curb dev\`, or set ${mcpTokenEnvVar(id)} in .env, then run \`npx curb mcp snapshot\` again.`,
      );
    } else {
      problems.push(`MCP server "${id}" did not list its tools within ${MCP_SNAPSHOT_TIMEOUT_MS / 1000} s. Fix: check that it is reachable, then run \`npx curb mcp snapshot\` again.`);
    }
  }
  return { servers, problems, skipped };
}

/** Resolves once no server of `manager` is still connecting, or after `timeoutMs`. */
export function mcpServersSettled(manager: McpManager, timeoutMs = MCP_SNAPSHOT_TIMEOUT_MS): Promise<void> {
  const connecting = () => manager.serverIds().some((id) => manager.resolve(id).status === "connecting");
  if (!connecting()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const stop = manager.onChange(() => {
      if (!connecting()) done();
    });
  });
}

/**
 * Connect the MCP servers of the project's agents for real: those the agents declare and those
 * added in `curb dev` (`ensureHostPrerequisites`), then every `<Mcp url>` a skill renders, by
 * rendering every skill of every agent once. Returns the manager once no server is connecting.
 */
async function connectProjectServers(): Promise<McpManager> {
  const { createAgentRuntime, listAgentIds } = await import("../server/bootstrap.js");
  for (const id of await listAgentIds()) (await createAgentRuntime(id)).runtime.skillCatalog();
  const manager = getMcpManager();
  await mcpServersSettled(manager);
  return manager;
}

/**
 * `curb mcp <args>` in the project at `projectRoot` (its .env already loaded). `connect` stands
 * in for connecting the project's servers (tests). Returns the exit code.
 */
export async function mcpCommand(
  args: readonly string[],
  projectRoot: string,
  options: { connect?: () => Promise<McpManager>; out?: (text: string) => void } = {},
): Promise<number> {
  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || !MCP_COMMANDS.includes(subcommand)) {
    throw new Error(`curb mcp: ${subcommand ? `unknown command "${subcommand}"` : "give the command"}.\n\n${MCP_USAGE}`);
  }
  if (rest.length > 0) throw new Error(`curb mcp snapshot: unknown argument ${rest[0]}.\n\n${MCP_USAGE}`);

  const manager = await (options.connect ?? connectProjectServers)();
  const { servers, problems, skipped } = snapshotMcpServers(manager);
  if (problems.length > 0) {
    console.error(`Nothing written: ${problems.length === 1 ? "an MCP server did not list its tools" : `${problems.length} MCP servers did not list their tools`}.`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  const ids = Object.keys(servers);
  for (const id of skipped) out(`skipped ${id}: it is configured with enabled: false or was disconnected, so it has no tools to list\n`);
  if (ids.length === 0) {
    out(`The agent has no MCP server, so there is nothing to write to ${MCP_TOOLS_FILE}.\n`);
    return 0;
  }
  writeFileSync(join(projectRoot, MCP_TOOLS_FILE), formatMcpToolsSnapshot(mcpToolsSnapshot(servers)));
  out(`Wrote ${MCP_TOOLS_FILE}: ${ids.map((id) => `${id} (${servers[id]!.length} tool${servers[id]!.length === 1 ? "" : "s"})`).join(", ")}. Commit it.\n`);
  return 0;
}
