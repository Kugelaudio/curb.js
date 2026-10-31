/**
 * How to start npm or npx. On Windows they are `.cmd` shims, which Node starts only
 * through a shell, so the arguments go into one quoted command line there.
 */
export function npmCommand(name, args, platform = process.platform) {
  if (platform !== "win32") return { file: name, args, shell: false };
  const unquotable = args.find((arg) => arg.includes('"'));
  if (unquotable) throw new Error(`Cannot pass ${unquotable} to ${name}: Windows allows no double quote in it.`);
  return { file: [name, ...args.map((arg) => `"${arg}"`)].join(" "), args: [], shell: true };
}
