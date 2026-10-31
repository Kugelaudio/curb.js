/** The scaffold's arguments: `my-agent` first when they do not start with a project folder. */
export function scaffoldArgs(args) {
  if (args.includes("--help") || args.includes("-h")) return args;
  return args.length > 0 && !args[0].startsWith("-") ? args : ["my-agent", ...args];
}
