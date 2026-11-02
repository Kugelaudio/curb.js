import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveProjectRoot } from "../../project.node.js";
import { type CommandOptions, rejectUnknownArguments } from "../args.js";
import { openBrowser } from "../open-browser.js";
import { login, loginWebUrl, logout } from "./auth.js";
import { CloudClient } from "./client.js";
import { ensureCredentials } from "./credentials.js";
import { type DeployResult, deploy, deployDescription } from "./deploy.js";
import { platformTokenTarget, readPlatformToken, refuseUnderPlatformToken } from "./platform-token.js";
import { type Prompter, reportHostedAgentsAccess, resolveTarget } from "./link.js";
import { envHasProjectKey, findCurbProject, finishLogin } from "./project-key.js";
import { pushSecrets } from "./secrets.js";

/** The `curb login | logout | deploy | secrets push` entry points `main.ts` dispatches to. */

const log = (line: string) => console.log(line);

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return undefined;
  const arg = args[index];
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

/** What each command takes. A dry run is the option a coding agent reaches for first. */
export const CLOUD_COMMAND_OPTIONS = {
  login: { flags: ["--no-open"], values: { "--url": "<web>" } },
  logout: { flags: [], values: {} },
  deploy: {
    flags: ["--no-activate", "--json"],
    values: { "--agent": "<id>", "--message": "<text>", "-m": "<text>" },
    instead: {
      "--dry-run":
        "For a dry run, `npx curb deploy --no-activate` builds the new version on the platform and checks " +
        "that it starts while the live version keeps serving, and `npx curb build` builds and starts it on " +
        "this machine without uploading anything.",
    },
  },
  "secrets push": { flags: [], values: { "--file": "<path>", "--agent": "<id>" } },
} satisfies Record<string, CommandOptions>;

/** A terminal prompter, or null when stdin is not interactive (CI, a coding agent's pipe). */
function terminalPrompter(): Prompter | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return {
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

export async function loginCommand(args: string[]): Promise<void> {
  rejectUnknownArguments(args, "login", CLOUD_COMMAND_OPTIONS.login);
  refuseUnderPlatformToken(process.env, "login", "No sign-in is needed: `npx curb deploy` already works.");
  const skipOpen = args.includes("--no-open") || Boolean(process.env.CURB_NO_OPEN);
  // In a Curb project whose .env has no key yet, the sign-in also creates one for it.
  const root = findCurbProject(resolveProjectRoot());
  const askForKey = root !== null && !envHasProjectKey(root);
  const result = await login({
    webUrl: loginWebUrl(flagValue(args, "--url")),
    open: skipOpen ? () => {} : openBrowser,
    log,
    requestProjectKey: askForKey,
    deviceName: hostname().replace(/\.local$/i, ""),
  });
  for (const line of finishLogin(root, askForKey, result)) log(line);
  await reportHostedAgentsAccess(new CloudClient(result.credentials), log);
}

export async function logoutCommand(args: string[]): Promise<void> {
  rejectUnknownArguments(args, "logout", CLOUD_COMMAND_OPTIONS.logout);
  await logout({ log });
}

export async function deployCommand(args: string[]): Promise<void> {
  rejectUnknownArguments(args, "deploy", CLOUD_COMMAND_OPTIONS.deploy);
  // --json: the progress goes to stderr, and stdout carries exactly one line, the result as a
  // JSON object, for a program that runs the deploy (a host's Publish). A failure prints
  // nothing there and exits non-zero with its reason on stderr, as without the flag.
  const json = args.includes("--json");
  const progress = json ? (line: string) => console.error(line) : log;
  const activate = !args.includes("--no-activate");
  const message = flagValue(args, "--message") ?? flagValue(args, "-m");
  const description = message === undefined ? undefined : deployDescription(message);
  const root = resolveProjectRoot();
  const hosted = readPlatformToken(process.env);
  let result: DeployResult;
  if (hosted) {
    if (flagValue(args, "--agent") !== undefined) {
      throw new Error("--agent is not available here: the platform token deploys only the agent it was issued for.");
    }
    const { access, target } = platformTokenTarget(hosted);
    result = await deploy({ client: new CloudClient(access), link: target, root, activate, description, log: progress });
  } else {
    const client = new CloudClient(await ensureCredentials());
    const link = await resolveTarget({
      client, root, agentId: flagValue(args, "--agent"), prompter: terminalPrompter(), log: progress,
    });
    result = await deploy({ client, link, root, activate, description, log: progress });
  }
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function secretsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "push") {
    throw new Error("Usage: curb secrets push [--file .env] [--agent <id>]");
  }
  rejectUnknownArguments(rest, "secrets push", CLOUD_COMMAND_OPTIONS["secrets push"]);
  refuseUnderPlatformToken(process.env, "secrets push", "Set this agent's secrets in the KugelAudio dashboard.");
  const root = resolveProjectRoot();
  const client = new CloudClient(await ensureCredentials());
  const link = await resolveTarget({ client, root, agentId: flagValue(rest, "--agent"), prompter: terminalPrompter(), log });
  await pushSecrets({ client, link, file: resolve(root, flagValue(rest, "--file") ?? join(root, ".env")), log });
}
