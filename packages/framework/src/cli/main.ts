import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DECLARATIONS_COMMAND, runDeclarationsChild } from "../bundler/declarations-child.js";
import { isLayerEscapeError, LAYER_ESCAPE_EXIT_CODE, layerEscapeLine } from "../bundler/layer-escape.js";
import { resolveAgentDir, resolveProjectRoot } from "../project.node.js";
import { curbVersion } from "../version.js";
import { applyPortFlag, wantsHelp } from "./args.js";
import type { StoredProjectKey } from "./cloud/credentials.js";
import { keepHostModelKeyFresh, useHostModelKey } from "./cloud/host-model-key.js";
import { PROJECT_KEY_VARIABLE, useLoginKey } from "./cloud/project-key.js";
import { runUpgrade } from "./upgrade.js";

const USAGE = `Usage: curb <command>

Run from your project root (the directory containing src/agent/).

Commands:
  dev        Start everything — preview, chat, voice agent — on one port (default 4000)
             and open the preview in your browser (--no-open or CURB_NO_OPEN=1 to skip).
             Saving a file under src/ (or context/*.md, .env) reloads the agent.
             --port <n> serves on exactly that port.
  check      Type-check src/ and run authoring diagnostics; exits 1 when errors are found.
  say        Run one caller turn headlessly and print the reply, tool calls and context
             change; successive calls continue one conversation (--new, --client key=value,
             --json; see curb say --help).
  test       Run the conversation scenarios in src/**/*.scenario.ts headlessly and print each
             transcript with pass or fail per check; exits 1 when one fails (<filter>, --json;
             see curb test --help).
  conversations
             Print the recorded conversations of curb dev and curb say with every tool call
             and result, to see what went wrong (--last <n>, --id <id>, --json).
  start      Run the agent's LiveKit voice worker in production mode; the framework runs
             the voice session.
             With CURB_MANAGEMENT_ADDR and CURB_MANAGEMENT_TOKEN set, dev and start also
             serve host protocol v1 for the calls they run (see docs/agent-guide/host-protocol.md).
  server     Start only the agent WebSocket server (no preview); --port <n> as for dev.
  build      Bundle the project into dist/ so it starts with no npm install and no tsc.
             The finished artifact is started in isolation to prove it runs
             (--no-verify to skip that check).
             --emit-layers <dir> also records the dependency layer split for a hosted builder;
             --dependency-layer <descriptor.json> builds only the app layer, and exits 75
             when the project reaches past the recorded build inputs.
  upgrade    Update this project's curb dependency to the latest published version (--check to only report).
  info       Print the versions, providers and environment variable names a bug report needs.
             Runs anywhere and starts nothing. Prints names only, never a value.
  --version  Print the curb version.
  --help     Print this help (curb <command> --help prints it too, and runs nothing).

KugelAudio hosting (see docs/agent-guide/deploying.md):
  login      Sign in with your KugelAudio account in the browser (--url <web> for another app URL,
             --no-open to only print the sign-in URL). Stored in ~/.config/curb/; a Curb project
             then runs on your login, with no key in .env (a KUGELAUDIO_API_KEY you set wins).
  logout     Revoke this machine's session and delete the stored credentials and project keys.
  deploy     Upload this project and make it the agent's live production deployment.
             The first run picks or creates the agent and saves it in .curb/link.json.
             --agent <id> to choose the agent, --no-activate to build without going live,
             --json to print the result as one JSON line on stdout (progress on stderr).
  secrets push
             Set every variable in .env on the agent's production environment
             (--file <path> for another file, --agent <id> as for deploy). Prints names only, never values.
`;

if (process.argv[2] === "--version" || process.argv[2] === "-v" || process.argv[2] === "version") {
  console.log(curbVersion());
  process.exit(0);
}

// Help runs nothing, wherever it is asked for: `curb dev --help` must not start a server.
if (process.argv[2] === "help" || wantsHelp(process.argv.slice(2))) {
  const usage =
    process.argv[2] === "say"
      ? (await import("./say.js")).SAY_USAGE
      : process.argv[2] === "conversations"
        ? (await import("./conversations.js")).CONVERSATIONS_USAGE
        : process.argv[2] === "test"
          ? (await import("./test.js")).TEST_USAGE
          : USAGE;
  process.stdout.write(`${usage}\n`, () => process.exit(0));
  await new Promise(() => {});
}

/**
 * Validate the working directory as a project, load its .env, and export the
 * root to every framework host started in this process (server, preview). With no
 * KUGELAUDIO_API_KEY in the environment or .env, the project runs on the key `curb login`
 * stored for it (`loginKey`, the stored key when it did), else on the model key a host
 * supplies beside its platform token (a hosted workspace), kept current while it runs.
 */
function prepareProject(): { projectRoot: string; loginKey: StoredProjectKey | null } {
  const projectRoot = resolveProjectRoot();
  process.env.AGENT_PROJECT_DIR = projectRoot;
  resolveAgentDir(projectRoot);
  const envFile = join(projectRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const loginKey = useLoginKey(projectRoot);
  if (!loginKey) {
    useHostModelKey();
    keepHostModelKeyFresh();
  }
  return { projectRoot, loginKey };
}

async function dev(): Promise<void> {
  // The environment before the project's .env: the agent server loads the .env itself each
  // time it starts, so a changed key applies on save (see dev.ts).
  const baseEnv = { ...process.env };
  const { projectRoot, loginKey } = prepareProject();
  // The key `curb login` stored is not in the .env the agent server loads: it starts with it.
  if (loginKey) baseEnv[PROJECT_KEY_VARIABLE] = loginKey.apiKey;
  applyPortFlag(process.argv.slice(3));
  // ONE port (default http://127.0.0.1:4000) for the preview, chat and voice; the agent
  // server runs behind it and reloads when the project's files change.
  const { runDev } = await import("./dev.js");
  await runDev({
    projectRoot,
    baseEnv,
    // Land the human in the preview. Skipped for automation (CI, agents, piped output)
    // and on request.
    open: !(
      process.argv.includes("--no-open") ||
      Boolean(process.env.CURB_NO_OPEN) ||
      Boolean(process.env.CI) ||
      !process.stdout.isTTY
    ),
  });
}

async function check(): Promise<void> {
  const { projectRoot, loginKey } = prepareProject();
  const { checkProject, printCheckReport } = await import("./check.js");
  process.exitCode = printCheckReport(await checkProject(projectRoot, { loginKey }));
}

async function say(): Promise<void> {
  const { projectRoot } = prepareProject();
  const { sayCommand } = await import("./say.js");
  const code = await sayCommand(process.argv.slice(3), projectRoot);
  // The agent's MCP clients and the LLM's sockets may hold the process open; the turn is
  // done once the result is written.
  process.stdout.write("", () => process.exit(code));
  await new Promise(() => {});
}

async function test(): Promise<void> {
  const { projectRoot } = prepareProject();
  const { testCommand } = await import("./test.js");
  const code = await testCommand(process.argv.slice(3), projectRoot);
  // As for say: open MCP clients and LLM sockets must not keep a finished run alive.
  process.stdout.write("", () => process.exit(code));
  await new Promise(() => {});
}

async function server(): Promise<void> {
  prepareProject();
  applyPortFlag(process.argv.slice(3));
  const { createAgentServer } = await import("../server/main.js");
  const agentServer = await createAgentServer();
  await agentServer.listen();
}

async function start(): Promise<void> {
  const { projectRoot } = prepareProject();
  const hasFlag = (name: string) =>
    process.argv.some((value) => value === name || value.startsWith(`${name}=`));
  const missingCredentials = [
    ["LIVEKIT_URL", "--url"],
    ["LIVEKIT_API_KEY", "--api-key"],
    ["LIVEKIT_API_SECRET", "--api-secret"],
  ].filter(([environment, flag]) => !process.env[environment] && !hasFlag(flag));
  if (missingCredentials.length > 0) {
    throw new Error(
      "Cannot start the hosted voice worker: missing " +
        `${missingCredentials.map(([environment]) => environment).join(", ")}. ` +
        "Add the LiveKit credentials to the project's .env or hosting secret store.",
    );
  }
  const { loadVoiceWorkerConfig } = await import("../orchestration.node.js");
  const { entry, agentName } = await loadVoiceWorkerConfig(projectRoot);
  const { cli: livekitCli, ServerOptions } = await import("@livekit/agents");

  // LiveKit forks one process per job. The framework itself registers tsx in
  // this process, while those children inherit only Node's execArgv, so install
  // the same TypeScript loader there: every job loads the framework's voice
  // session and the project's agent from TypeScript source.
  const tsxLoader = import.meta.resolve("tsx");
  const alreadyLoadsTsx = process.execArgv.some((value) => value.includes("tsx"));
  if (!alreadyLoadsTsx) process.execArgv.push("--import", tsxLoader);

  // The host protocol's management port, when CURB_MANAGEMENT_ADDR and CURB_MANAGEMENT_TOKEN
  // are both set: every call a job runs is registered on it under its room name. Opened
  // before the worker forks its job processes, which inherit the link to it.
  const { openWorkerManagement } = await import("../hosted/serve-call.js");
  const management = await openWorkerManagement();
  if (management !== null) {
    console.log(`curb: host protocol v1 on http://${management.address}/v1 (calls by room name)`);
  }

  livekitCli.runApp(new ServerOptions({ agent: entry, agentName }));
}

/**
 * Bundle the project for hosting.
 *
 * This command was deliberately absent for a long time, and the recorded reason was
 * that node-only modules behind runtime guards could not be tree-shaken out of a
 * BROWSER production bundle. That reason does not apply here: `curb build` emits a
 * Node bundle for a server runtime, where those modules are wanted rather than
 * stripped. The browser preview is unchanged and still built by Vite.
 */
async function build(): Promise<void> {
  const { runCurbBuild } = await import("../bundler/index.js");
  const args = process.argv.slice(3);
  const outFlag = args.indexOf("--out");
  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`curb build: ${flag} needs a value.`);
    }
    return value;
  };
  const emitLayers = valueOf("--emit-layers");
  const dependencyLayer = valueOf("--dependency-layer");

  const result = await runCurbBuild({
    projectRoot: process.cwd(),
    outDir: outFlag >= 0 ? args[outFlag + 1] : undefined,
    skipTrace: args.includes("--no-trace"),
    skipVerify: args.includes("--no-verify"),
    emitLayers,
    dependencyLayer,
  });

  const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(2)} MB`;
  console.log(`\ncurb build -> ${result.outDir}`);
  console.log(`  bundle   ${mb(result.bundleBytes)}  ${result.entry}`);
  if (result.layers?.mode === "hit") {
    console.log(
      `  layer    ${result.layers.dependencyFiles} dependency file(s) from ${dependencyLayer}, ` +
        `built against ${result.layers.buildInputs} recorded input(s)`,
    );
  } else if (!args.includes("--no-trace")) {
    console.log(`  runtime  ${mb(result.tracedBytes)}  ${result.tracedFiles} files`);
    // Named rather than folded into the file count: each of these is a dependency the
    // tracer could not see, restored to the version the project installed.
    console.log(`  mirrored ${result.mirroredPackages} package(s) the trace could not reach`);
  }
  if (result.layers?.mode === "emit" && emitLayers !== undefined) {
    console.log(
      `  layers   ${result.layers.dependencyFiles} dependency file(s), ` +
        `${result.layers.buildInputs} build input(s) -> ${resolve(emitLayers)}`,
    );
  }
  // The artifact's IDENTITY, printed because it is what a deployment records and what a
  // runner verifies before it reads a byte of the tree. Two builds of one revision
  // printing two different digests is the determinism assertion failing in the open.
  console.log(`  digest   ${result.treeDigest}`);
  console.log(`           over ${result.manifestFiles} file(s) listed in curb.bundle.json`);

  // The one line that says the artifact RAN, as opposed to compiled. Reported with the
  // entrypoint it started, because "which file does the runner execute" is itself one
  // of the things that has been wrong.
  if (result.verification) {
    const seconds = (result.verification.durationMs / 1000).toFixed(1);
    console.log(
      `  verified started a worker from ${result.verification.entrypoint} in ${seconds}s`,
    );
    // Starting is not the same as having something to say: report what the artifact
    // actually rendered, which is the thing a start marker cannot see.
    const render = result.verification.render;
    if (render) {
      console.log(
        `  rendered  ${render.skills.length} skill(s), ${render.contextDocs.length} ` +
          `context doc(s) from ${render.contextFiles.length} bundled markdown file(s)`,
      );
    }
  } else if (result.layers?.mode === "hit") {
    console.log(
      "  verified NO — a dependency-layer build holds only the app layer; the deployment's " +
        "readiness probe starts the assembled artifact",
    );
  } else {
    console.log("  verified NO — the artifact was not started, so it is not known to run");
  }

  // Warnings are classified, not swallowed and not dumped. ~90 benign warnings would
  // bury the one that actually matters, and a wholesale filter would hide it too.
  const { summarizeWarnings, CLASS_EXPLANATION } = await import("../bundler/warnings.js");
  const summary = summarizeWarnings(result.warnings);

  const benign = Object.entries(summary.counts).filter(
    ([cls, count]) => cls !== "unclassified" && count > 0,
  );
  if (benign.length > 0) {
    console.log("\n  known-benign trace warnings:");
    for (const [cls, count] of benign) {
      const why = CLASS_EXPLANATION[cls as keyof typeof CLASS_EXPLANATION];
      console.log(`    ${String(count).padStart(3)}  ${why}`);
    }
  }

  if (summary.unclassified.length > 0) {
    console.log(
      `\n  \u001b[31m${summary.unclassified.length} UNRECOGNISED warning(s)\u001b[0m ` +
        "— each may be a module missing at runtime:",
    );
    for (const warning of summary.unclassified) console.log(`    - ${warning}`);
  }

  console.log();
}

async function conversations(): Promise<void> {
  const { conversationsCommand } = await import("./conversations.js");
  process.exitCode = conversationsCommand(process.argv.slice(3), resolveProjectRoot());
}

async function upgrade(): Promise<void> {
  await runUpgrade(process.argv.slice(3));
}

async function info(): Promise<void> {
  const { infoReport } = await import("./info.js");
  console.log(await infoReport(resolveProjectRoot()));
}

async function cloudCommand(name: "login" | "logout" | "deploy" | "secrets"): Promise<void> {
  const cloud = await import("./cloud/commands.js");
  const args = process.argv.slice(3);
  if (name === "login") return cloud.loginCommand(args);
  if (name === "logout") return cloud.logoutCommand(args);
  // The same "run this from the project root" error every other project command gives.
  resolveAgentDir(resolveProjectRoot());
  if (name === "deploy") return cloud.deployCommand(args);
  return cloud.secretsCommand(args);
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  dev,
  check,
  say,
  test,
  start,
  server,
  build,
  upgrade,
  info,
  conversations,
  login: () => cloudCommand("login"),
  logout: () => cloudCommand("logout"),
  deploy: () => cloudCommand("deploy"),
  secrets: () => cloudCommand("secrets"),
  // Not in USAGE: the child `curb build` reads the agent's goals and experiments in.
  [DECLARATIONS_COMMAND]: () => runDeclarationsChild(process.argv[3]),
};
const run = command ? commands[command] : undefined;

/** Commands people reach for that curb does not have, each with what to run instead. */
const INSTEAD: Record<string, string> = {
  whoami: 'To see or change the KugelAudio account, run `npx curb login`: it signs in and prints "Signed in as <email>".',
};

if (!run) {
  const instead = command && Object.hasOwn(INSTEAD, command) ? ` ${INSTEAD[command]}` : "";
  console.error(command ? `${USAGE}\nUnknown command "${command}".${instead}` : USAGE);
  process.exit(1);
}

try {
  await run();
} catch (error) {
  if (isLayerEscapeError(error)) {
    // Not a failure of the project: the hosted builder falls back to a full build in the same
    // attempt. The prose goes to stdout so stderr carries exactly the one line it parses, and
    // the exit waits for that line to flush.
    console.log(`curb build: ${error.message}`);
    process.stderr.write(`${layerEscapeLine(error)}\n`, () => process.exit(LAYER_ESCAPE_EXIT_CODE));
    await new Promise(() => {});
  }
  // CLI contract: failures surface as a readable message (agents consume
  // these); set DEBUG=1 for the full stack.
  if (process.env.DEBUG) console.error(error);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
