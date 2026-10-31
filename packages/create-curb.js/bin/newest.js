/** The create-curb-app release `<cdn>/latest.json` names, as `{ version, url }`. */
export async function newestCreateApp(cdn, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const pointer = `${cdn}/latest.json`;
  const response = await fetchImpl(pointer, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${pointer} answered HTTP ${response.status}`);
  const { version, tarball } = (await response.json())?.createApp ?? {};
  if (typeof version !== "string" || typeof tarball !== "string") throw new Error(`${pointer} names no release`);
  return { version, url: `${cdn}/${tarball}` };
}

/** The arguments for create-curb-app: `my-agent` first when they do not start with a project folder. */
export function scaffoldArgs(args) {
  if (args.includes("--help") || args.includes("-h")) return args;
  return args.length > 0 && !args[0].startsWith("-") ? args : ["my-agent", ...args];
}
