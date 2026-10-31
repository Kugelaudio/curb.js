// npm 12 runs a dependency's install script only when the project's package.json
// "allowScripts" approves it, and an install that skipped one still exits 0. The template
// decides every install script a fresh project meets (it denies the ones it lists, none of
// which the agent needs); this check turns any other skipped script into a failed setup,
// instead of an agent that fails at its first turn (a native binding that was never built).
import { execFileSync } from "node:child_process";
import { npmCommand } from "./npm-command.js";

/** The first npm major that blocks dependency install scripts by default. */
export const FIRST_BLOCKING_NPM_MAJOR = 12;

/** The packages `npm install-scripts ls --json` reports with a pending install script: one
 * that allowScripts neither approves nor denies, so npm skipped it. */
export function pendingInstallScripts(lsJson) {
  const report = JSON.parse(lsJson);
  if (!report || !Array.isArray(report.allowScripts)) {
    throw new Error(`npm install-scripts ls --json printed no "allowScripts" list: ${lsJson.trim().slice(0, 200)}`);
  }
  return report.allowScripts
    .filter((entry) => entry.changes.some((change) => change.change === "pending"))
    .map((entry) => entry.name);
}

/** The two commands, run inside the project, that approve the skipped scripts and run them. */
export function installScriptsFix(names) {
  return [`npm install-scripts approve ${names.join(" ")}`, `npm rebuild ${names.join(" ")}`];
}

/** The packages whose install scripts npm skipped in `dir`. None before npm 12, which runs
 * every dependency's install script. */
export function blockedInstallScripts(dir) {
  const npm = (...args) => {
    const command = npmCommand("npm", args);
    return execFileSync(command.file, command.args, { cwd: dir, encoding: "utf8", shell: command.shell });
  };
  const npmVersion = npm("--version").trim();
  if (Number(npmVersion.split(".")[0]) < FIRST_BLOCKING_NPM_MAJOR) return [];
  return pendingInstallScripts(npm("install-scripts", "ls", "--json"));
}
