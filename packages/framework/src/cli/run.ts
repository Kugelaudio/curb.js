import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RUN_USAGE = `Usage: curb run <script> [args...]

Runs a script of your own with the project loaded, as curb dev loads it: TypeScript and JSX,
the project's .env, and the key of npx curb login. A script that imports curb/testing drives
the project's agent (startCall, testModel, judge, report and the rest; see
node_modules/curb/docs/agent-guide/testing-api.md), locally and in CI.

The script gets the arguments after its path in process.argv, as node would give them.
Its exit code is the command's: what it sets with process.exitCode or process.exit(code),
else 0; 1 when it throws. Options after the script's path are the script's.`;

/**
 * Run `script` in this process, as `node` would run it with `args`, in the project at
 * `projectRoot` (already prepared). Resolves with the exit code the script set, else 0; a
 * script that throws is printed with its stack and gives 1.
 */
export async function runScript(script: string, args: readonly string[], projectRoot: string): Promise<number> {
  const path = resolve(projectRoot, script);
  if (!existsSync(path)) {
    throw new Error(`[CURB_RUN_NOT_FOUND] No script at ${script}.\nFix: pass the path of a .ts or .js file, relative to the project: npx curb run scripts/my-tests.ts`);
  }
  process.argv = [process.argv[0]!, path, ...args];
  try {
    await import(pathToFileURL(path).href);
  } catch (error) {
    console.error(error);
    return 1;
  }
  const code = Number(process.exitCode ?? 0);
  return Number.isInteger(code) ? code : 1;
}
