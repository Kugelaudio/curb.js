import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOOK_LIMIT_MS, HOOK_NAMES, declaredHook, isHookName, type CallEvent, type CallRecord, type HookName } from "../hooks.js";
import { hookErrorMessage, invokeHook } from "../hosted/hook-runs.js";
import { resolveAgentDir } from "../project.node.js";
import { hookEvent } from "../testing/hooks.js";
import { rejectUnknownArguments } from "./args.js";

export const HOOK_USAGE = `Usage: curb hook <afterCall|afterEvaluation> --call <fixture.json>

Runs one of the agent's hooks once, in this process, on a call from a file, as a hosted run does:
(call, event), within the same limit, with the keys from the project's .env. The hook's own
console output comes first; the last line says how it ended. Exit code 1 when it failed.

It is the agent's real code, so what it writes, it writes. curb dev and curb say never fire
a hook by themselves.

  --call <fixture.json>  a whole event (the body of a webhook), or a call object with the fields
                         the hook reads: the rest is a plain completed call. afterCall runs on
                         call.ended, where goals is null; afterEvaluation on call.evaluated.`;

export type HookArgs = { name: HookName; file: string };

/** `curb hook` arguments: the hook's name, and `--call <file>` or `--call=<file>`. */
export function parseHookArgs(args: readonly string[]): HookArgs {
  const name = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "--call");
  rejectUnknownArguments(
    args.filter((arg) => arg !== name),
    "hook",
    { flags: [], values: { "--call": "<fixture.json>" } },
  );
  if (name === undefined || !isHookName(name)) {
    throw new Error(`curb hook: name the hook to run: ${HOOK_NAMES.join(" or ")}.\n\n${HOOK_USAGE}`);
  }
  const at = args.findIndex((arg) => arg === "--call" || arg.startsWith("--call="));
  const flag = args[at];
  const file = flag === "--call" ? args[at + 1] : flag?.slice("--call=".length);
  if (!file) throw new Error(`curb hook: --call takes the fixture to run it on.\n\n${HOOK_USAGE}`);
  return { name, file };
}

/** The JSON in `file`, a whole event or a call object. */
function readFixture(file: string): Partial<CallRecord> | CallEvent {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`curb hook: cannot read the fixture ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  throw new Error(`curb hook: the fixture ${file} must hold a JSON object: a whole event or a call.`);
}

/** Runs `curb hook` in the project at `projectRoot`, with its .env loaded. Returns the exit code. */
export async function hookCommand(args: readonly string[], projectRoot: string): Promise<number> {
  const { name, file } = parseHookArgs(args);
  const event = hookEvent(name, readFixture(file));
  // Imported here, as `curb say` imports its session: it is what makes the agent's module load.
  const { loadAgentDefinition } = await import("../agent.node.js");
  const hook = declaredHook(await loadAgentDefinition(resolveAgentDir(projectRoot)), name);

  const startedAt = performance.now();
  const outcome = await invokeHook(hook, event, HOOK_LIMIT_MS);
  const took = `${Math.round(performance.now() - startedAt)} ms`;
  if (outcome.state === "succeeded") {
    console.log(`[${name} succeeded] ${event.id} in ${took}`);
    return 0;
  }
  // The stack is for the person at this terminal; a host reads the message alone.
  if (outcome.cause instanceof Error && !outcome.timedOut) console.error(outcome.cause.stack);
  console.log(`[${name} failed] ${event.id} after ${took}: ${hookErrorMessage(outcome.cause)}`);
  return 1;
}
