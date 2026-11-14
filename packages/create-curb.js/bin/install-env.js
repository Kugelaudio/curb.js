// onnxruntime-node's postinstall downloads extra binaries (GPU builds) from a host other than
// the npm registry. The agent does not need them, and on a network that allows only the
// registry the download fails and takes the whole npm install down with it. npm 10 runs the
// script even when package.json's allowScripts denies it, so the install skips the download
// through the package's own switches, unless the user already chose one.
import { execFileSync } from "node:child_process";
import { npmCommand } from "./npm-command.js";

/** The npm config keys onnxruntime-node's postinstall reads (as npm_config_<key>, dashes as
 * underscores); the same two are read from the environment as ONNXRUNTIME_NODE_INSTALL[_CUDA]. */
export const INSTALL_PREFERENCE_KEYS = ["onnxruntime-node-install", "onnxruntime-node-install-cuda"];

const hasPreference = (env) =>
  Object.entries(env).some(
    ([name, value]) =>
      value && /^(?:ONNXRUNTIME_NODE_INSTALL(?:_CUDA)?|npm_config_onnxruntime_node_install(?:_cuda)?)$/i.test(name),
  );

/** The value npm resolves for a config key (environment, project and user .npmrc), or undefined
 * when it is unset. Throws when npm cannot answer, for example inside an npm 10 workspace
 * (ENOWORKSPACES). The workspace flags are no way round that: they answer "undefined" for a
 * key the workspace root's .npmrc sets. */
export function readNpmConfig(key, cwd) {
  const command = npmCommand("npm", ["config", "get", key]);
  const value = execFileSync(command.file, command.args, {
    cwd,
    encoding: "utf8",
    shell: command.shell,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return value && value !== "undefined" && value !== "null" ? value : undefined;
}

const LOOKUP_FAILED_NOTE =
  "Could not read npm config, so the install keeps your onnxruntime-node settings as they are and may download extra binaries.";

/** The environment for `npm install`: the downloads are skipped, unless the user set a
 * preference for them in the environment or in npm's config, which is then left alone. When
 * npm's config cannot be read the preference is unknown, so nothing is injected and `note`
 * gets one line saying so. */
export function installEnv(base = process.env, npmConfig = readNpmConfig, note = console.error) {
  if (hasPreference(base)) return { ...base };
  try {
    if (INSTALL_PREFERENCE_KEYS.some((key) => npmConfig(key))) return { ...base };
  } catch {
    note(LOOKUP_FAILED_NOTE);
    return { ...base };
  }
  return { ...base, ONNXRUNTIME_NODE_INSTALL: "skip", ONNXRUNTIME_NODE_INSTALL_CUDA: "skip" };
}

/** The lines printed after a failed install: the fix in the form of the user's shell. */
export function installFailureHint(targetArg, platform = process.platform) {
  const head = `If a download was blocked by your network, run inside ${targetArg}:`;
  if (platform === "win32") {
    return [
      head,
      "  Command Prompt: set ONNXRUNTIME_NODE_INSTALL=skip&& set ONNXRUNTIME_NODE_INSTALL_CUDA=skip&& npm install",
      "  PowerShell:     $env:ONNXRUNTIME_NODE_INSTALL='skip'; $env:ONNXRUNTIME_NODE_INSTALL_CUDA='skip'; npm install",
    ].join("\n");
  }
  return `${head} ONNXRUNTIME_NODE_INSTALL=skip ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install`;
}
