import { CLI_REFUSAL_CODES, CliRefusal } from "./refusal.js";

/** The options one command takes. */
export type CommandOptions = {
  /** Options that take no value (`--no-activate`). */
  flags: readonly string[];
  /** Options that take one, each with what its value is (`{ "--agent": "<id>" }`, given as
   * `--agent <id>` or `--agent=<id>`). */
  values: Readonly<Record<string, string>>;
  /** Options people reach for that this command does not have, each with what to run instead. */
  instead?: Readonly<Record<string, string>>;
};

/**
 * Refuse the first argument `command` does not take, naming what to use: the replacement
 * `instead` lists for it, else the nearest option by spelling, and always the options there are.
 */
export function rejectUnknownArguments(args: readonly string[], command: string, options: CommandOptions): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (Object.hasOwn(options.values, name)) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (!options.flags.includes(name)) throw unknownArgument(name, command, options);
  }
}

function unknownArgument(name: string, command: string, options: CommandOptions): CliRefusal {
  const known = [...Object.entries(options.values).map(([option, value]) => `${option} ${value}`), ...options.flags];
  const takes = known.length === 0 ? `curb ${command} takes no options.` : `curb ${command} takes ${known.join(", ")}.`;
  const nearest = nearestOption(name, [...Object.keys(options.values), ...options.flags]);
  const instead = options.instead && Object.hasOwn(options.instead, name) ? options.instead[name] : null;
  const hint = instead ?? (nearest ? `Did you mean ${nearest}?` : null);
  return new CliRefusal(
    CLI_REFUSAL_CODES.unknownArgument,
    `curb ${command} has no option ${JSON.stringify(name)}.`,
    hint ? `${hint} ${takes}` : takes,
  );
}

/** The option `name` is most likely a misspelling of: at most three edits away, else none. */
function nearestOption(name: string, options: readonly string[]): string | null {
  let best: { option: string; distance: number } | null = null;
  for (const option of options) {
    const distance = editDistance(name, option);
    if (distance <= 3 && (best === null || distance < best.distance)) best = { option, distance };
  }
  return best?.option ?? null;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length];
}

/** The value of `flag` (`--agent <id>` or `--agent=<id>`), undefined when it is not given. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return undefined;
  const arg = args[index];
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

/** `--help` or `-h` anywhere: print the usage and run nothing. */
export function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** The value of `--port <n>` / `--port=<n>`; undefined when the flag is absent. */
export function portFlag(args: readonly string[]): number | undefined {
  const index = args.findIndex((arg) => arg === "--port" || arg.startsWith("--port="));
  if (index < 0) return undefined;
  const flag = args[index];
  const raw = flag === "--port" ? args[index + 1] : flag.slice("--port=".length);
  const port = Number(raw);
  if (raw === undefined || !/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(
      `--port needs a port number from 1 to 65535${raw === undefined ? "" : `, got ${JSON.stringify(raw)}`}. ` +
        "Example: curb dev --port 4100",
    );
  }
  return port;
}

/**
 * Apply `--port` to what the server reads (`WS_PORT`, then `PORT`). Called after the project's
 * .env is loaded, so the flag wins over it. A port given this way is used exactly: when it is
 * taken the server fails instead of moving to the next one.
 */
export function applyPortFlag(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const port = portFlag(args);
  if (port !== undefined) {
    env.WS_PORT = String(port);
    env.PORT = String(port);
  }
  return port;
}
