#!/usr/bin/env node
// `npm create curb.js my-agent`: scaffolds a new agent project from templates/default, pinned
// to the curb.js release with this package's version, so `npm create curb.js@preview` gives a
// project on the matching preview. It asks nothing: the project runs on KugelAudio
// (LLM, speech-to-text, text-to-speech) unless flags pick other providers, and
// provider API keys come from the environment.
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { blockedInstallScripts, installScriptsFix } from "./install-scripts.js";
import { exitOnUnsupportedNode } from "./node-version.js";
import { installEnv, installFailureHint } from "./install-env.js";
import { npmCommand } from "./npm-command.js";
import { scaffoldArgs } from "./scaffold-args.js";

exitOnUnsupportedNode(new URL("../package.json", import.meta.url));

const USAGE = `Usage: npm create curb.js <directory> -- [options]

Creates a new agent framework project in <directory> (my-agent when none is named).

The project runs on KugelAudio for speech-to-text, the LLM and text-to-speech,
all on one login. The options below pick other providers; anything you omit
keeps its default, and provider API keys are read from the environment.

Options:
  --stt <provider>     kugelaudio | azure | deepgram | elevenlabs | openai   (default kugelaudio)
  --llm <provider>     kugelaudio | anthropic | openai | openai-compatible   (default kugelaudio)
  --tts <provider>     kugelaudio | cartesia | elevenlabs | openai (default kugelaudio)
  --model <id>         LLM model id (default qwen3.8-27b on KugelAudio)
  --stt-model <id>     STT model id (provider default otherwise)
  --tts-model <id>     TTS model id (provider default otherwise)
  --llm-base-url <url> Endpoint for --llm openai-compatible
  --framework <spec>   Dependency spec for the "curb" package (a version or
                       file:/path). Defaults to the local framework checkout,
                       else the curb.js release that matches this package.
  --skip-install       Do not run npm install.
  --skip-git           Do not initialize a git repository.
  --yes, -y            Accepted and ignored (nothing is asked).
  --help, -h           Show this help.

Provider API keys (read from the environment):
  KUGELAUDIO_API_KEY  ANTHROPIC_API_KEY  OPENAI_API_KEY  AZURE_SPEECH_KEY
  AZURE_SPEECH_REGION  DEEPGRAM_API_KEY  ELEVEN_API_KEY  CARTESIA_API_KEY

npm create curb.js@preview creates the project on the newest preview.

Example (into the empty current folder; .env gets an empty line for each other
provider key the environment does not hold, for the user to fill in; KugelAudio
runs on npx curb login, or on a KUGELAUDIO_API_KEY you set):
  npm create curb.js .
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------- arguments
const args = scaffoldArgs(process.argv.slice(2));
let targetArg;
let frameworkSpec;
let skipInstall = false;
let skipGit = false;
// Provider/model selections passed as flags.
const cli = {};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const takeValue = (name) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) fail(`${name} needs a value.\n\n${USAGE}`);
    index += 1;
    return value;
  };
  if (arg === "--framework") frameworkSpec = takeValue("--framework");
  else if (arg === "--stt") cli.stt = takeValue("--stt");
  else if (arg === "--llm") cli.llm = takeValue("--llm");
  else if (arg === "--tts") cli.tts = takeValue("--tts");
  else if (arg === "--model") cli.model = takeValue("--model");
  else if (arg === "--stt-model") cli.sttModel = takeValue("--stt-model");
  else if (arg === "--tts-model") cli.ttsModel = takeValue("--tts-model");
  else if (arg === "--llm-base-url") cli.llmBaseUrl = takeValue("--llm-base-url");
  else if (arg === "--yes" || arg === "-y") continue; // nothing is asked; kept so existing commands still run
  else if (arg === "--skip-install") skipInstall = true;
  else if (arg === "--skip-git") skipGit = true;
  else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (arg.startsWith("-")) fail(`Unknown option "${arg}".\n\n${USAGE}`);
  else if (targetArg) fail(`Unexpected argument "${arg}".\n\n${USAGE}`);
  else targetArg = arg;
}

if (!targetArg) fail(USAGE);

const targetDir = resolve(targetArg);

// Package dir of this CLI, used to find bundled templates.
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A repo checkout installs the sibling framework package; a published copy, curb.js from npm.
const localFramework = resolve(pkgDir, "../framework");
const repoCheckout = existsSync(join(localFramework, "package.json"));

const appName = basename(targetDir);

if (!/^[a-z0-9][a-z0-9._-]*$/.test(appName)) {
  fail(
    `"${appName}" is not a valid project name — use lowercase letters, digits, ".", "_", "-" (npm package name rules).`,
  );
}
if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
  fail(`${targetDir} is a file. Choose a new directory.`);
}
if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
  fail(`${targetDir} already exists and is not empty. Choose a new directory.`);
}

// ------------------------------------------------- resolve the framework dep
// A project imports "curb" and installs it from npm as curb.js, because npm's `curb` is someone
// else's package. A published copy pins its own version, so the two always match. (npm installs
// file: directories as symlinks, so a repo-linked project behaves like a workspace member.)
const CURB_ON_NPM = "npm:curb.js";
if (!frameworkSpec) {
  const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  frameworkSpec = repoCheckout ? `file:${localFramework}` : `${CURB_ON_NPM}@${version}`;
} else if (/^\d/.test(frameworkSpec)) {
  frameworkSpec = `${CURB_ON_NPM}@${frameworkSpec}`;
} else if (/^https?:/i.test(frameworkSpec)) {
  fail(`--framework takes a version or a file: path, not ${frameworkSpec}: Curb is published to npm only.`);
}

// ------------------------------------------------------------ provider table
// A provider's API key is read ONCE and reused for every pipeline slot it
// covers (ElevenLabs STT+TTS, or an OpenAI LLM+STT, need a single key).
const KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  azure: "AZURE_SPEECH_KEY",
  kugelaudio: "KUGELAUDIO_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  elevenlabs: "ELEVEN_API_KEY",
  cartesia: "CARTESIA_API_KEY",
};

// The providers each flag accepts (first = default).
const STT_PROVIDERS = ["kugelaudio", "azure", "deepgram", "elevenlabs", "openai"];
const LLM_PROVIDERS = ["kugelaudio", "anthropic", "openai", "openai-compatible"];
const TTS_PROVIDERS = ["kugelaudio", "cartesia", "elevenlabs", "openai"];

// Each provider's default model; a provider missing here has a single model and
// takes none. Model ids verified against the LiveKit plugin type definitions and
// the KugelAudio model docs.
const DEFAULT_STT_MODEL = { deepgram: "nova-3", openai: "gpt-realtime-whisper" };
const DEFAULT_TTS_MODEL = {
  kugelaudio: "kugel-3.5",
  cartesia: "sonic-3",
  elevenlabs: "eleven_turbo_v2_5",
  openai: "tts-1",
};
const defaultSttModel = (provider) => DEFAULT_STT_MODEL[provider] ?? null;
const defaultTtsModel = (provider) => DEFAULT_TTS_MODEL[provider] ?? null;
// KugelAudio's EU-hosted LLMs, the models `kugelaudio.llm({ model })` takes (first = default).
const KUGELAUDIO_LLM_MODELS = ["qwen3.8-27b", "mistral-medium-3.5-128b"];
const KUGELAUDIO_LLM_MODEL = KUGELAUDIO_LLM_MODELS[0];
const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:11434/v1";

// LiveKit plugin packages per provider — ONLY selected ones are installed.
// azure + kugelaudio are framework-native and need no plugin.
const PLUGIN_VERSION = "^1.5.1";
const PLUGIN_PACKAGES = {
  deepgram: "@livekit/agents-plugin-deepgram",
  elevenlabs: "@livekit/agents-plugin-elevenlabs",
  cartesia: "@livekit/agents-plugin-cartesia",
  openai: "@livekit/agents-plugin-openai",
};

/** The model an LLM provider starts with unless --model names one. */
const defaultLlmModel = (provider) =>
  ({ kugelaudio: KUGELAUDIO_LLM_MODEL, anthropic: "claude-haiku-4-5", openai: "gpt-5.2" })[provider] ?? "llama3.3";

// ------------------------------------------------------------------ selection
const answers = {
  llm: "kugelaudio",
  agentModel: KUGELAUDIO_LLM_MODEL,
  llmBaseUrl: DEFAULT_LLM_BASE_URL,
  llmApiKey: "",
  stt: "kugelaudio",
  sttModel: null, // provider default (null when the provider has a single model)
  tts: "kugelaudio",
  ttsModel: defaultTtsModel("kugelaudio"),
  keys: {}, // env name -> value (provider API keys + AZURE_SPEECH_REGION)
};

/** Ordered list of providers whose shared API key the project needs, de-duplicated
 * across the STT/LLM/TTS picks (OpenAI as STT+LLM → one key). */
function keyProvidersFor(picks) {
  const order = [];
  const seen = new Set();
  for (const id of picks) {
    if (!id || id === "openai-compatible") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

/** The .env map from the selection. The .env holds keys only; WHICH providers run is
 * written into src/agent/agent.tsx as <Agent> props. */
function finalizeEnv() {
  const env = { ...answers.keys };
  if (answers.llm === "openai-compatible" && answers.llmApiKey) env.AGENT_LLM_API_KEY = answers.llmApiKey;
  return env;
}

/** The language the template agent speaks: its prompts and kugelaudio.tts()'s default voice
 * are English. Kugel Ear is told so, because without a language it guesses between German
 * and English. */
const TEMPLATE_LANGUAGE = "en";

/** The picked providers as `curb/providers` source: the import line and the <Agent> tag.
 * A model is written only when it differs from the provider's own default. */
function providerSource(a) {
  const q = (value) => JSON.stringify(value);
  // A factory's options object as source, with only the options that are set ("" for none).
  const options = (entries) => {
    const set = Object.entries(entries).filter(([, value]) => value);
    return set.length === 0 ? "" : `{ ${set.map(([key, value]) => `${key}: ${q(value)}`).join(", ")} }`;
  };
  const changed = (model, fallback) => (model && model !== fallback ? model : null);
  const factories = new Set([a.stt, a.tts]);
  let llm;
  if (a.llm === "openai-compatible") {
    factories.add("openaiCompatible");
    llm = `openaiCompatible({ baseURL: ${q(a.llmBaseUrl || DEFAULT_LLM_BASE_URL)}, model: ${q(a.agentModel)} })`;
  } else if (a.llm === "kugelaudio") {
    factories.add("kugelaudio");
    llm = `kugelaudio.llm(${options({ model: changed(a.agentModel, KUGELAUDIO_LLM_MODEL) })})`;
  } else {
    factories.add(a.llm);
    llm = `${a.llm}(${q(a.agentModel)})`;
  }
  const stt = `${a.stt}.stt(${options({
    model: changed(a.sttModel, defaultSttModel(a.stt)),
    language: a.stt === "kugelaudio" ? TEMPLATE_LANGUAGE : null,
  })})`;
  const tts = `${a.tts}.tts(${options({ model: changed(a.ttsModel, defaultTtsModel(a.tts)) })})`;
  return {
    importLine: `import { ${[...factories].sort().join(", ")} } from "curb/providers";`,
    agentTag: `<Agent llm={${llm}} stt={${stt}} tts={${tts}}>`,
  };
}

// Apply --stt/--llm/--tts/--model flags over the defaults. Unknown provider
// values fail loudly (never a silent fallback to the default).
function applyCliSelections() {
  const validate = (label, value, allowed) => {
    if (!allowed.includes(value)) {
      fail(`Invalid --${label} "${value}". Choose one of: ${allowed.join(", ")}.`);
    }
    return value;
  };
  if (cli.stt) answers.stt = validate("stt", cli.stt, STT_PROVIDERS);
  if (cli.llm) {
    answers.llm = validate("llm", cli.llm, LLM_PROVIDERS);
    // Model default follows the chosen LLM unless --model overrides it.
    answers.agentModel = defaultLlmModel(answers.llm);
  }
  if (cli.tts) answers.tts = validate("tts", cli.tts, TTS_PROVIDERS);
  if (cli.model) answers.agentModel = cli.model;
  if (answers.llm === "kugelaudio") validate("model", answers.agentModel, KUGELAUDIO_LLM_MODELS);
  if (cli.llmBaseUrl) answers.llmBaseUrl = cli.llmBaseUrl;
  // Models default to each provider's own default when not overridden.
  answers.sttModel = cli.sttModel ?? defaultSttModel(answers.stt);
  answers.ttsModel = cli.ttsModel ?? defaultTtsModel(answers.tts);
}

function seedKeysFromEnv() {
  for (const id of keyProvidersFor([answers.stt, answers.llm, answers.tts])) {
    const keyEnv = KEY_ENV[id];
    if (process.env[keyEnv]) answers.keys[keyEnv] = process.env[keyEnv];
  }
  if (answers.stt === "azure" || answers.tts === "azure") {
    answers.keys.AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || "eastus";
  }
  if (answers.llm === "openai-compatible" && process.env.AGENT_LLM_API_KEY) {
    answers.llmApiKey = process.env.AGENT_LLM_API_KEY;
  }
}

applyCliSelections();
seedKeysFromEnv();
const envValues = finalizeEnv();

// -------------------------------------------------------------- copy template
const templateDir = resolve(dirname(fileURLToPath(import.meta.url)), "../templates/default");
try {
  mkdirSync(targetDir, { recursive: true });
  cpSync(templateDir, targetDir, { recursive: true });
} catch (error) {
  fail(`Cannot create the project in ${targetDir} (${error.code ?? error.message}). Choose a directory you can write to.`);
}

// npm strips .gitignore from published tarballs, so the template ships it without the
// leading dot. The project carries no .npmrc: hosted builds refuse one.
renameSync(join(targetDir, "gitignore"), join(targetDir, ".gitignore"));
renameSync(join(targetDir, "env.example"), join(targetDir, ".env.example"));

// package.json placeholders + the LiveKit plugin deps for the SELECTED voice
// providers only (none for the native azure/kugelaudio paths).
const pluginDeps = {};
for (const id of new Set([answers.stt, answers.tts])) {
  if (PLUGIN_PACKAGES[id]) pluginDeps[PLUGIN_PACKAGES[id]] = PLUGIN_VERSION;
}

const manifestPath = join(targetDir, "package.json");
const manifest = JSON.parse(
  readFileSync(manifestPath, "utf8")
    .replaceAll("{{APP_NAME}}", appName)
    .replaceAll("{{FRAMEWORK_SPEC}}", frameworkSpec),
);
manifest.dependencies = Object.fromEntries(
  Object.entries({ ...manifest.dependencies, ...pluginDeps }).sort(([a], [b]) => a.localeCompare(b)),
);
// The keys a hosted build refuses to start without: those of the SELECTED providers, not the
// template's defaults (an Azure STT project must also be asked for its Azure key).
const requiredKeys = [
  ...new Set(keyProvidersFor([answers.llm, answers.stt, answers.tts]).map((id) => KEY_ENV[id])),
].sort();
manifest.curb.requiredRuntimeSecrets = requiredKeys;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// README.md's title is the project name.
const readmePath = join(targetDir, "README.md");
writeFileSync(readmePath, readFileSync(readmePath, "utf8").replaceAll("{{APP_NAME}}", appName));

// agent.tsx: the picked providers become the <Agent> props. The template's default line
// is replaced whole, so a provider other than the defaults imports its own factory.
const TEMPLATE_PROVIDER_IMPORT = 'import { kugelaudio } from "curb/providers";';
const TEMPLATE_AGENT_TAG =
  '<Agent llm={kugelaudio.llm()} stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts()}>';
const agentPath = join(targetDir, "src/agent/agent.tsx");
const templateAgent = readFileSync(agentPath, "utf8");
if (!templateAgent.includes(TEMPLATE_PROVIDER_IMPORT) || !templateAgent.includes(TEMPLATE_AGENT_TAG)) {
  fail("create-curb.js: templates/default/src/agent/agent.tsx no longer has the provider lines this installer rewrites.");
}
const providers = providerSource(answers);
writeFileSync(
  agentPath,
  templateAgent
    // Function replacers: a model id containing "$&" must land verbatim.
    .replace(TEMPLATE_PROVIDER_IMPORT, () => providers.importLine)
    .replace(TEMPLATE_AGENT_TAG, () => providers.agentTag),
);

// .env: every key entered, plus an empty line for each other key the selected providers
// need, in a stable order. Always written, so the keys have one place to go. KugelAudio's key
// is written only when the setup got one: without it the project runs on `npx curb login`.
const ENV_ORDER = [
  "ANTHROPIC_API_KEY",
  "AGENT_LLM_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_SPEECH_KEY",
  "AZURE_SPEECH_REGION",
  "KUGELAUDIO_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVEN_API_KEY",
  "CARTESIA_API_KEY",
];
const envLines = ENV_ORDER.filter(
  (name) => envValues[name] || (requiredKeys.includes(name) && name !== "KUGELAUDIO_API_KEY"),
).map(
  (name) => `${name}=${envValues[name] ?? ""}`,
);
writeFileSync(join(targetDir, ".env"), envLines.map((line) => `${line}\n`).join(""));

// ---------------------------------------------------------- output + install
/** The curb orange (256-color ANSI; picocolors has no orange), plain when color is off. */
const orange = (text) => (pc.isColorSupported ? `\x1b[38;5;208m${text}\x1b[39m` : text);

function gitInit() {
  const inRepo = (() => {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: targetDir, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  if (skipGit || inRepo) return false;
  try {
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: targetDir, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: targetDir, stdio: "ignore" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: targetDir, stdio: "ignore" });
    }
    execFileSync("git", ["add", "-A"], { cwd: targetDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial commit from create-curb.js"], {
      cwd: targetDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    // KEEP-JUSTIFIED: git is optional; a failed init must not fail scaffolding.
    return false;
  }
}

/**
 * Animated install progress: spinner + what npm is fetching right now + an
 * elapsed-seconds counter, so a long install is never a silent wait.
 * npm's own progress bar dies when piped, so its http log is streamed
 * instead and the current package name lifted from the fetch URLs.
 */
function installWithSpinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let at = 0;
  const started = Date.now();
  let detail = "resolving packages";
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  const render = () => {
    const line = `${orange(frames[at])} Installing dependencies ${pc.dim(`· ${detail} · ${elapsed()}s`)}`;
    process.stdout.write(`\r\x1b[K${line}`);
  };
  render();
  const timer = setInterval(() => {
    at = (at + 1) % frames.length;
    render();
  }, 120);

  // Resolves true when npm install exited 0.
  return new Promise((resolveInstall) => {
    const finish = (ok, line, tail) => {
      clearInterval(timer);
      process.stdout.write(`\r\x1b[K${line}\n`);
      if (tail) console.error(tail);
      resolveInstall(ok);
    };
    const npm = npmCommand("npm", ["install", "--loglevel=http", "--no-fund", "--no-audit"]);
    const child = spawn(npm.file, npm.args, { cwd: targetDir, shell: npm.shell, env: installEnv() });
    const stderrLines = [];
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      for (const rawLine of text.split("\n")) {
        const trimmed = rawLine.trim();
        if (trimmed) stderrLines.push(trimmed);
      }
      if (stderrLines.length > 60) stderrLines.splice(0, stderrLines.length - 60);
      // "npm http fetch GET 200 https://…/react-dom-19.2.7.tgz 84ms" → react-dom-19.2.7
      const fetches = text.match(/https?:\/\/\S+\/([^/\s]+)\.tgz/g);
      const name = fetches?.at(-1)?.match(/\/([^/]+)\.tgz$/)?.[1];
      if (name) detail = name.length > 42 ? `${name.slice(0, 41)}…` : name;
    });
    child.on("error", (error) => {
      finish(
        false,
        `${pc.red("✖")} npm install could not start ${pc.dim(`(${error.message})`)}`,
        `Run "npm install" inside ${targetArg} yourself.`,
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(true, `${pc.green("✔")} Dependencies installed ${pc.dim(`in ${elapsed()}s`)}`);
        return;
      }
      // The http fetch log is noise in a failure report — show real errors.
      const tail = stderrLines.filter((line) => !line.startsWith("npm http")).slice(-10).join("\n");
      finish(
        false,
        `${pc.red("✖")} npm install failed ${pc.dim(`after ${elapsed()}s`)}`,
        `${tail}\nRun "npm install" inside ${targetArg} to see the full output.\n${installFailureHint(targetArg)}`,
      );
    });
  });
}

/** npm install with npm's own full output, for automation (piped stdout: agents, CI). */
function installPlain() {
  console.log("Installing dependencies…");
  try {
    // Warnings and errors only: no progress chatter, funding or audit summary.
    const npm = npmCommand("npm", ["install", "--loglevel=warn", "--no-fund", "--no-audit"]);
    execFileSync(npm.file, npm.args, { cwd: targetDir, stdio: "inherit", shell: npm.shell, env: installEnv() });
    return true;
  } catch (error) {
    // npm printed its errors above; this names what failed and where to retry.
    console.error(`${pc.red("✖")} npm install failed (${error.message.split("\n")[0]}). Run "npm install" inside ${targetArg}.\n${installFailureHint(targetArg)}`);
    return false;
  }
}

/** Fails the setup when npm skipped a dependency's install script, naming the two commands
 * that fix it: the install exits 0, and the project would fail at its first turn instead. */
function exitOnBlockedInstallScripts() {
  let blocked;
  try {
    blocked = blockedInstallScripts(targetDir);
  } catch (error) {
    fail(`${pc.red("✖")} Could not list the install scripts npm skipped: ${error.message}\nRun "npm install-scripts ls" inside ${targetArg}.`);
  }
  if (blocked.length === 0) return;
  const [approve, rebuild] = installScriptsFix(blocked);
  fail(
    [
      `${pc.red("✖")} npm skipped the install scripts of ${blocked.join(", ")}, so the agent would fail at its first turn.`,
      `Approve and run them inside ${targetArg}:`,
      `  ${approve}`,
      `  ${rebuild}`,
    ].join("\n"),
  );
}

// The keys the selected providers need that the environment did not hold.
const missingKeys = requiredKeys.filter((name) => !envValues[name]);
const otherMissingKeys = missingKeys.filter((name) => name !== "KUGELAUDIO_API_KEY");
const allKugelAudio = [answers.llm, answers.stt, answers.tts].every((id) => id === "kugelaudio");
const step = (command, note) => `${orange(command.padEnd(16))}${pc.dim(note)}`;
const nextSteps = [
  // Scaffolded into the current folder ("."): nothing to change into.
  ...(targetDir === process.cwd() ? [] : [orange(`cd ${targetArg}`)]),
  ...(missingKeys.includes("KUGELAUDIO_API_KEY") ? [step("npx curb login", "sign in in your browser")] : []),
  ...(otherMissingKeys.length > 0 ? [`Add your keys to .env: ${otherMissingKeys.join(", ")}`] : []),
  step("npm run dev", "then open http://127.0.0.1:4000 and talk to your agent"),
];

console.log(`${pc.green("✔")} ${pc.bold(appName)} created`);
if (allKugelAudio) {
  console.log(
    pc.dim("  Uses KugelAudio for speech and the language model. You can change providers later in src/agent/agent.tsx."),
  );
}
if (gitInit()) console.log(`${pc.green("✔")} Git repository initialized`);
if (skipInstall) console.log(pc.dim("Skipped npm install (--skip-install)."));
else {
  // A live terminal gets the spinner; automation (piped stdout: agents, CI) gets npm's
  // own full output instead.
  const installed = process.stdout.isTTY ? await installWithSpinner() : installPlain();
  if (!installed) process.exit(1);
  exitOnBlockedInstallScripts();
}
console.log(["", "Next:", ...nextSteps.map((line) => `  ${line}`), ""].join("\n"));
