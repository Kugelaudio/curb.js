// Scaffolds a project (no install, no git) and checks the
// generated tree. A hosted deploy refuses any symbolic link in the source, so the tree
// an unchanged project starts from must contain none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bin = fileURLToPath(new URL("../bin/create-curb.js", import.meta.url));
const templates = fileURLToPath(new URL("../templates", import.meta.url));
const template = join(templates, "default");
const BUSINESS_TEMPLATES = { support: "Mara", booking: "Lena" };
const ALL_TEMPLATES = ["default", ...Object.keys(BUSINESS_TEMPLATES)].map((name) => join(templates, name));

function scaffold(t, flags = []) {
  const root = mkdtempSync(join(tmpdir(), "create-curb.js-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "app");
  const result = run(root, [project, ...flags]);
  assert.equal(result.status, 0, result.stderr);
  return project;
}

/** create-curb.js with the test's flags, no install, no git, from `cwd`; its result. */
function run(cwd, args) {
  return spawnSync(
    process.execPath,
    [bin, ...args, "--skip-install", "--skip-git", "--framework", "file:/unused"],
    // No provider keys: the test must not write a developer's real keys to disk.
    { cwd, env: { PATH: process.env.PATH, HOME: cwd }, encoding: "utf8" },
  );
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

function* symlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) yield path;
    else if (entry.isDirectory()) yield* symlinks(path);
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("a new project installs one onnxruntime-node, the version curb runs", (t) => {
  // Silero pins an older onnxruntime-node that npm would install a second time under it.
  // Built agents load the framework's copy, so the template points Silero at that one too.
  const project = scaffold(t);
  const framework = readJson(fileURLToPath(new URL("../../framework/package.json", import.meta.url)));
  const root = readJson(fileURLToPath(new URL("../../../package.json", import.meta.url)));
  const runtime = framework.dependencies["onnxruntime-node"];
  assert.match(runtime, /^\d+\.\d+\.\d+$/);
  const overrides = readJson(join(project, "package.json")).overrides;
  assert.deepEqual(overrides, { "@livekit/agents-plugin-silero": { "onnxruntime-node": runtime } });
  assert.deepEqual(root.overrides["@livekit/agents-plugin-silero"], overrides["@livekit/agents-plugin-silero"]);
});

test("the generated project contains no symbolic link", (t) => {
  const project = scaffold(t);
  const links = [...symlinks(project)].map((path) => relative(project, path));
  assert.deepEqual(links, []);
});

test("CLAUDE.md is a regular file that imports AGENTS.md", (t) => {
  const project = scaffold(t);
  assert.ok(lstatSync(join(project, "CLAUDE.md")).isFile());
  assert.equal(readFileSync(join(project, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.ok(lstatSync(join(project, "AGENTS.md")).isFile());
});

// Claude Code started in the project gets the KugelAudio account and docs MCP servers from
// .mcp.json, so AGENTS.md points there instead of asking for a `claude mcp add` command.
test(".mcp.json registers the KugelAudio MCP servers, and AGENTS.md points at it", (t) => {
  const project = scaffold(t);
  assert.deepEqual(readJson(join(project, ".mcp.json")), {
    mcpServers: {
      kugelaudio: { type: "http", url: "https://www.kugelaudio.com/mcp" },
      "kugelaudio-docs": { type: "http", url: "https://docs.kugelaudio.com/mcp" },
    },
  });
  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  assert.match(agents, /\.mcp\.json/);
  assert.doesNotMatch(agents, /claude mcp add/);
});

// AGENTS.md is what a coding agent acts on, and the MCP server lives in another repository, so
// a name it does not register fails only when an agent calls it. This list is the tools the
// file may name: add to it after checking the name on the live server.
const MCP_TOOLS_IN_AGENTS_MD = new Set([
  "agent_add_dependency", "agent_check", "agent_create", "agent_create_upload", "agent_delete_file",
  "agent_deploy", "agent_edit_file", "agent_get_call", "agent_get_call_timeline", "agent_get_logs",
  "agent_get_preview_conversation", "agent_get_preview_log", "agent_list", "agent_list_calls",
  "agent_list_files", "agent_list_preview_conversations", "agent_open", "agent_overview",
  "agent_publish", "agent_read_file", "agent_remove_dependency", "agent_request_secret",
  "agent_restart_preview", "agent_say", "agent_search", "agent_set_secrets", "agent_write_file",
]);

test("AGENTS.md names only the MCP server's tools, under their current names", () => {
  const agents = readFileSync(join(template, "AGENTS.md"), "utf8");
  const named = [...agents.matchAll(/`(agent_[a-z_]+)`/g)].map((match) => match[1]);
  assert.ok(named.length > 0);
  assert.deepEqual(named.filter((name) => !MCP_TOOLS_IN_AGENTS_MD.has(name)), []);
  const beforeTheRename = /`[a-z]+_agent(_[a-z_]+)?`/g;
  assert.deepEqual(agents.match(beforeTheRename) ?? [], []);
});

// a new project needs exactly one key, and a hosted agent none of its own.
test("every guide page AGENTS.md and the guide name in backticks ships", () => {
  const guide = fileURLToPath(new URL("../../framework/docs/agent-guide", import.meta.url));
  const pages = readdirSync(guide).filter((file) => file.endsWith(".md"));
  const sources = [join(template, "AGENTS.md"), ...pages.map((file) => join(guide, file))];
  const named = sources.flatMap((source) =>
    [...readFileSync(source, "utf8").matchAll(/`([a-z][a-z-]*\.md)`/g)].map((match) => match[1]),
  );
  assert.ok(named.length > 0);
  assert.deepEqual([...new Set(named)].filter((page) => !pages.includes(page)), []);
});

test("the default agent runs on KugelAudio's LLM, Kugel Ear and Kugel TTS, all on the one KugelAudio key", (t) => {
  const project = scaffold(t);
  const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
  assert.match(
    agent,
    /<Agent llm=\{kugelaudio\.llm\(\)\} stt=\{kugelaudio\.stt\(\{ language: "en" \}\)\} tts=\{kugelaudio\.tts\(\)\}>/,
  );
  assert.match(agent, /import \{ kugelaudio \} from "curb\/providers";/);
  const manifest = readJson(join(project, "package.json"));
  // Framework-native: no LiveKit plugin package, and no Azure key asked for.
  assert.ok(!Object.keys(manifest.dependencies).some((name) => name.startsWith("@livekit/agents-plugin-")));
  assert.deepEqual(manifest.curb.requiredRuntimeSecrets, ["KUGELAUDIO_API_KEY"]);
  for (const file of [".env.example", "README.md", "AGENTS.md"]) {
    assert.doesNotMatch(readFileSync(join(project, file), "utf8"), /ANTHROPIC/, file);
  }
});

// create-curb.js asks nothing: with no provider flags, in a terminal or not, it writes the
// KugelAudio defaults straight away and prints no question.
for (const stdin of ["closed", "tty-less pipe"]) {
  test(`no flags and a ${stdin} stdin writes the KugelAudio defaults without a question`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "create-curb.js-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "app");
    const result = spawnSync(process.execPath, [bin, project, "--skip-install", "--skip-git", "--framework", "file:/unused"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root },
      encoding: "utf8",
      // "closed": stdin is /dev/null. "tty-less pipe": a pipe that stays open and never answers.
      stdio: [stdin === "closed" ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\?/);
    assert.match(result.stdout, /Uses KugelAudio for speech and the language model/);
    assert.match(result.stdout, /npx curb login/);
    const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
    assert.match(
      agent,
      /<Agent llm=\{kugelaudio\.llm\(\)\} stt=\{kugelaudio\.stt\(\{ language: "en" \}\)\} tts=\{kugelaudio\.tts\(\)\}>/,
    );
  });
}

test("a target that cannot be created is refused with a message, not a stack trace", (t) => {
  const root = mkdtempSync(join(tmpdir(), "create-curb-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "taken");
  writeFileSync(file, "");
  for (const [target, message] of [
    [file, /is a file\. Choose a new directory\./],
    [join(file, "app"), /Cannot create the project in .*Choose a directory you can write to\./],
  ]) {
    const result = run(root, [target]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test("--yes is accepted and changes nothing", (t) => {
  const project = scaffold(t, ["--yes"]);
  assert.match(readFileSync(join(project, "src/agent/agent.tsx"), "utf8"), /llm=\{kugelaudio\.llm\(\)\}/);
});

test("--model picks the other KugelAudio model, and one KugelAudio does not serve is refused", (t) => {
  const project = scaffold(t, ["--model", "mistral-medium-3.5-128b"]);
  const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
  assert.match(agent, /llm=\{kugelaudio\.llm\(\{ model: "mistral-medium-3\.5-128b" \}\)\}/);

  const root = mkdtempSync(join(tmpdir(), "create-curb.js-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refused = run(root, [join(root, "app"), "--model", "claude-haiku-4-5"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Invalid --model "claude-haiku-4-5"\. Choose one of: qwen3\.8-27b, mistral-medium-3\.5-128b\./);
});

test("--llm anthropic still writes Claude and asks for its key", (t) => {
  const project = scaffold(t, ["--llm", "anthropic"]);
  const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
  assert.match(agent, /<Agent llm=\{anthropic\("claude-haiku-4-5"\)\} stt=/);
  assert.match(agent, /import \{ anthropic, kugelaudio \} from "curb\/providers";/);
  assert.deepEqual(readJson(join(project, "package.json")).curb.requiredRuntimeSecrets, [
    "ANTHROPIC_API_KEY",
    "KUGELAUDIO_API_KEY",
  ]);
  assert.equal(readFileSync(join(project, ".env"), "utf8"), "ANTHROPIC_API_KEY=\n");
});

// A coding agent started in an empty folder scaffolds into it, so the .mcp.json, CLAUDE.md
// and AGENTS.md it reads at start are the project's.
test("scaffolds into the empty current folder with .", (t) => {
  const root = mkdtempSync(join(tmpdir(), "create-curb.js-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "my-agent");
  mkdirSync(folder);
  const result = run(folder, ["."]);
  assert.equal(result.status, 0, result.stderr);
  for (const file of [".mcp.json", "CLAUDE.md", "AGENTS.md", "src/agent/agent.tsx"]) {
    assert.ok(existsSync(join(folder, file)), file);
  }
  assert.equal(readJson(join(folder, "package.json")).name, "my-agent");
  assert.doesNotMatch(result.stdout, /\bcd\b/);
});

test("--stt azure still writes Azure speech-to-text and asks for its key", (t) => {
  const project = scaffold(t, ["--stt", "azure"]);
  const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
  assert.match(agent, /stt=\{azure\.stt\(\)\} tts=\{kugelaudio\.tts\(\)\}/);
  assert.match(agent, /import \{ azure, kugelaudio \} from "curb\/providers";/);
  assert.deepEqual(readJson(join(project, "package.json")).curb.requiredRuntimeSecrets, [
    "AZURE_SPEECH_KEY",
    "KUGELAUDIO_API_KEY",
  ]);
  assert.match(readFileSync(join(project, ".env"), "utf8"), /^AZURE_SPEECH_KEY=\nAZURE_SPEECH_REGION=eastus\n/m);
});

// The README tells the user to put the keys into .env, so the file exists even when the
// setup got no key: one empty line per key the selected providers need.
test(".env lists the keys to fill in, but not KUGELAUDIO_API_KEY: curb login provides it", (t) => {
  const project = scaffold(t);
  assert.equal(readFileSync(join(project, ".env"), "utf8"), "");
});

// The platform materializes its starter from the same template and refuses an unfilled
// placeholder, so the scaffold must fill every one too.
test("no generated file keeps a template placeholder", (t) => {
  const project = scaffold(t);
  const unfilled = [...files(project)].filter((path) => /\{\{[A-Z_]+\}\}/.test(readFileSync(path, "utf8")));
  assert.deepEqual(unfilled.map((path) => relative(project, path)), []);
  assert.match(readFileSync(join(project, "README.md"), "utf8"), /^# app\n/);
});

test("the generated project carries no voice session code of its own", (t) => {
  // The framework runs the voice session on every route, so a project carries no copy of
  // it: a src/orchestration/ would only be ignored (`curb check` warns AGENT_ORCHESTRATION_IGNORED).
  const project = scaffold(t);
  assert.ok(!existsSync(join(project, "src", "orchestration")));
  assert.deepEqual(readdirSync(join(project, "src")), ["agent"]);
});

// npm 12 skips every dependency install script that package.json "allowScripts" does not
// decide, and create-curb.js stops the setup for any it skipped. The conversation
// store is a plain file now, so the template approves no script for it.
test("the template decides every install script, with true or false", () => {
  const { allowScripts } = readJson(join(template, "package.json"));
  for (const [name, allowed] of Object.entries(allowScripts)) {
    assert.equal(typeof allowed, "boolean", `allowScripts["${name}"] must be true or false`);
  }
});

// @livekit/agents 1.9.4 (2026-10-24) depends on @livekit/blingfire, whose install script is a
// no-op (`node -e ""`; its native binding ships prebuilt). Left undecided, npm 12 skips it and
// create-curb.js stops the setup as if the agent could not run.
test("the template denies @livekit/blingfire's no-op install script", () => {
  const { allowScripts } = readJson(join(template, "package.json"));
  assert.equal(allowScripts["@livekit/blingfire"], false);
});

// JSX joins multi-line text into one line before Curb sees it (`curb check` warns
// AGENT_PROSE_JSX_TEXT), so the template's prose is one template literal per component.
test("template prose is written as template literals, never multi-line JSX text", () => {
  const prose = /<(SystemPrompt|Instruction|Text)>\s*\n\s*[^\s{<]/;
  const offenders = ALL_TEMPLATES.flatMap((dir) =>
    [...files(join(dir, "src"))].filter((path) => prose.test(readFileSync(path, "utf8"))),
  );
  assert.deepEqual(offenders.map((path) => relative(templates, path)), []);
});

// The framework tells the model today's date on every turn, so a date or a clock time in
// the template would be wrong on every other day.
test("no template hard-codes a date or clock time", () => {
  const dated =
    /\b(19|20)\d\d\b|\b\d{1,2}:\d\d\b|\b(January|February|March|April|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;
  const offenders = ALL_TEMPLATES.flatMap((dir) =>
    [...files(join(dir, "src")), ...files(join(dir, "context"))].filter((path) => dated.test(readFileSync(path, "utf8"))),
  );
  assert.deepEqual(offenders.map((path) => relative(templates, path)), []);
});

// A hosted build accepts public npm with package-lock.json only and refuses a project npm
// config ("project file \"npmrc\" is not supported"), so the scaffold must not write one.
test("the project has no npm config file, which hosted builds refuse", (t) => {
  const project = scaffold(t);
  for (const file of [".npmrc", "npmrc"]) assert.ok(!existsSync(join(project, file)), file);
  assert.ok(!existsSync(join(template, "npmrc")) && !existsSync(join(template, ".npmrc")));
});

// Every template shows the three kinds of test a project should keep: a simulated caller with a
// persona and judged expectations, a scripted gate, and a check of the agent's state at the end.
for (const name of ["default", ...Object.keys(BUSINESS_TEMPLATES)]) {
  test(`--template ${name} ships a simulated scenario, a scripted gate and an end-state check`, (t) => {
    const project = scaffold(t, ["--template", name]);
    const agentDir = join(project, "src/agent");
    const scenarios = readdirSync(agentDir).filter((file) => file.endsWith(".scenario.ts")).map((file) => readFileSync(join(agentDir, file), "utf8"));
    assert.ok(scenarios.length >= 2 && scenarios.length <= 3, `${scenarios.length} scenario file(s)`);
    const simulated = scenarios.filter((source) => /\bcaller: \{/.test(source));
    const scripted = scenarios.filter((source) => /\bturns: \[/.test(source));
    assert.equal(simulated.length, 1);
    assert.ok(scripted.length >= 1);
    for (const source of simulated) {
      assert.match(source, /\.\.\.personas\.\w+/);
      assert.match(source, /\bexpectations: \[/);
      // Its tools may run on every run only because the scenario says so.
      assert.match(source, /\brealTools: \[/);
    }
    for (const source of scenarios) assert.match(source, /\bstate(Matches)?[(<]/);
    // A store a scenario reads is one the agent defines.
    const agent = readFileSync(join(agentDir, "agent.tsx"), "utf8");
    const stores = [...agent.matchAll(/createAgentStore<[\s\S]*?>\("([a-z]+)"/g)].map((match) => match[1]);
    const read = scenarios.flatMap((source) => [...source.matchAll(/\bstate(?:Matches)?(?:<[^>]*>)?\("([a-z]+)"/g)].map((match) => match[1]));
    assert.ok(read.length > 0);
    assert.deepEqual(read.filter((store) => !stores.includes(store)), []);
    // And a tool it lets run for real is one the agent has.
    const tools = [...agent.matchAll(/\bname="([a-z_]+)"/g)].map((match) => match[1]);
    const allowed = simulated.flatMap((source) => [...(source.match(/realTools: \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]));
    assert.deepEqual(allowed.filter((tool) => !tools.includes(tool)), []);
  });
}

// The workflow is what a new repository runs on its first pull request, with a secret in reach:
// it is held to the rules this repository's own workflows follow.
test("every project ships a workflow that runs curb check and curb test on pull requests", (t) => {
  for (const name of ["default", ...Object.keys(BUSINESS_TEMPLATES)]) {
    const project = scaffold(t, ["--template", name]);
    const workflow = readFileSync(join(project, ".github/workflows/curb-test.yml"), "utf8");
    assert.match(workflow, /^on:\n {2}pull_request:\n/m);
    assert.doesNotMatch(workflow, /pull_request_target/);
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
    assert.match(workflow, /KUGELAUDIO_API_KEY: \$\{\{ secrets\.KUGELAUDIO_API_KEY \}\}/);
    assert.match(workflow, /run: npx curb check\n/);
    assert.match(workflow, /run: npx curb test --runs \d+ --max-tokens \d+\n/);
    // Third-party actions are pinned to a commit, and no checkout leaves its token behind.
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
    assert.ok(uses.length >= 2);
    assert.deepEqual(uses.filter((action) => !/@[0-9a-f]{40}$/.test(action)), []);
    assert.match(workflow, /persist-credentials: false/);
  }
});

test("AGENTS.md sends a coding agent through check, say and repeated test runs, and to the findings", () => {
  const agents = readFileSync(join(template, "AGENTS.md"), "utf8");
  const steps = ["`npx curb check`", "`npx curb say", "`npx curb test --runs 3`"].map((step) => agents.indexOf(step));
  assert.ok(steps.every((at) => at > 0), "a step is missing");
  assert.deepEqual([...steps].sort((a, b) => a - b), steps);
  assert.match(agents, /each `find` line\s+names a turn and quotes it/);
  assert.match(agents, /`npx curb test --rejudge latest`/);
});

// A model that never asked for the name books under "Caller". The booking tool refuses that, so
// the calendar never holds a booking nobody can be greeted by.
test("the booking agent refuses a placeholder where the caller's name belongs", () => {
  const module = new URL("../templates/booking/src/agent/calendar.ts", import.meta.url).href;
  const names = ["Alex Example", "Zoë", "O'Brien", "Caller", " the caller ", "CUSTOMER", "user", "Unknown", "guest", "N/A", "n.a.", "-", "  ", "???"];
  const script = `
    import { isPersonName } from ${JSON.stringify(module)};
    console.log(JSON.stringify(${JSON.stringify(names)}.map((name) => isPersonName(name))));
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, true, true, false, false, false, false, false, false, false, false, false, false, false]);
  const agent = readFileSync(join(templates, "booking/src/agent/agent.tsx"), "utf8");
  assert.match(agent, /if \(!isPersonName\(input\.name\)\) \{\s+return \{ ok: false, message: `"\$\{input\.name\}" is not a name\. Ask the caller for their name, then book with it\.` \};/);
});

// A simulated caller's scenario that needs every one of three runs fails a pull request now and
// then on an agent that is right nine times in ten. The shipped ones need two of three.
test("each template's simulated scenario runs three times and needs two of them, and its scripted one stays a gate", () => {
  for (const dir of ALL_TEMPLATES) {
    const agentDir = join(dir, "src/agent");
    for (const file of readdirSync(agentDir).filter((name) => name.endsWith(".scenario.ts"))) {
      const source = readFileSync(join(agentDir, file), "utf8");
      if (/\bcaller: \{/.test(source)) {
        assert.match(source, /\n {2}runs: 3,\n {2}minPassRate: 0\.66,\n/, file);
      } else {
        assert.doesNotMatch(source, /\b(runs|minPassRate):/, file);
      }
    }
  }
});

/** Runs this package as npm installs it at `version`: no framework checkout beside it. */
function scaffoldFromPublishedCopy(t, version, flags = []) {
  const root = mkdtempSync(join(tmpdir(), "create-curb-js-published-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "create-curb.js");
  const source = fileURLToPath(new URL("..", import.meta.url));
  for (const part of ["bin", "templates"]) cpSync(join(source, part), join(pkg, part), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...readJson(join(source, "package.json")), version }));
  mkdirSync(join(root, "node_modules"));
  const picocolors = dirname(createRequire(import.meta.url).resolve("picocolors/package.json"));
  symlinkSync(picocolors, join(root, "node_modules", "picocolors"));
  const project = join(root, "app");
  const result = spawnSync(
    process.execPath,
    [join(pkg, "bin/create-curb.js"), project, "--skip-install", "--skip-git", ...flags],
    { cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return readJson(join(project, "package.json"));
}

// `npm create curb.js` and `npm create curb.js@preview` differ only in the version npm picks.
for (const version of ["1.15.0", "1.16.0-preview.3"]) {
  test(`a published ${version} pins curb.js at ${version} under the name projects import`, (t) => {
    const manifest = scaffoldFromPublishedCopy(t, version);
    assert.equal(manifest.dependencies.curb, `npm:curb.js@${version}`);
  });
}

test("--framework takes a bare version as a curb.js version, never npm's unrelated curb package", (t) => {
  const manifest = scaffoldFromPublishedCopy(t, "1.15.0", ["--framework", "1.14.1"]);
  assert.equal(manifest.dependencies.curb, "npm:curb.js@1.14.1");
});

test("--framework passes a file: spec through", (t) => {
  const manifest = scaffoldFromPublishedCopy(t, "1.15.0", ["--framework", "file:/some/curb"]);
  assert.equal(manifest.dependencies.curb, "file:/some/curb");
});

test("--framework refuses a tarball URL, since Curb is published to npm only", () => {
  const url = "https://example.test/curb.tgz";
  const result = spawnSync(process.execPath, [bin, "app", "--skip-install", "--skip-git", "--framework", url], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--framework takes a version or a file: path/);
});

test("a repo checkout links the sibling framework", (t) => {
  const root = mkdtempSync(join(tmpdir(), "create-curb.js-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "app");
  const result = spawnSync(process.execPath, [bin, project, "--skip-install", "--skip-git"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readJson(join(project, "package.json")).dependencies.curb, /^file:.*packages\/framework$/);
});

// The business templates lay their own src/agent, context and README over templates/default, so
// the shared files (AGENTS.md, package.json, tsconfig, .mcp.json) exist once.
for (const [name, agentName] of Object.entries(BUSINESS_TEMPLATES)) {
  test(`--template ${name} scaffolds ${agentName} on the KugelAudio defaults, with no trace of Juno`, (t) => {
    const project = scaffold(t, ["--template", name]);
    const agent = readFileSync(join(project, "src/agent/agent.tsx"), "utf8");
    assert.match(agent, new RegExp(`You are ${agentName},`));
    assert.match(
      agent,
      /<Agent llm=\{kugelaudio\.llm\(\)\} stt=\{kugelaudio\.stt\(\{ language: "en" \}\)\} tts=\{kugelaudio\.tts\(\)\}>/,
    );
    assert.deepEqual(readJson(join(project, "package.json")).curb.requiredRuntimeSecrets, ["KUGELAUDIO_API_KEY"]);
    assert.deepEqual([...symlinks(project)], []);
    assert.ok(!existsSync(join(project, "src/agent/about-you")) && !existsSync(join(project, "context/about-you.md")));
    for (const path of files(project)) {
      assert.doesNotMatch(readFileSync(path, "utf8"), /Juno|\{\{[A-Z_]+\}\}/, relative(project, path));
    }
    // Every skill the agent links exists as a folder, and its markdown file exists too.
    for (const [, path] of agent.matchAll(/<Skill path="\/([a-z-]+)"/g)) {
      const skill = readFileSync(join(project, "src/agent", path, "skill.tsx"), "utf8");
      for (const [, md] of skill.matchAll(/<Text src="([^"]+)"/g)) assert.ok(existsSync(join(project, "context", md)), md);
    }
  });
}

test("--template with a name no template has is refused, naming the choices", (t) => {
  const root = mkdtempSync(join(tmpdir(), "create-curb.js-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root, [join(root, "app"), "--template", "nope"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --template "nope"\. Choose one of: default, booking, support\./);
});

test("the default template is untouched: --template default writes the same tree as no flag, and AGENTS.md as shipped", (t) => {
  const plain = scaffold(t);
  const named = scaffold(t, ["--template", "default"]);
  const list = (dir) => [...files(dir)].map((path) => relative(dir, path)).sort();
  assert.deepEqual(list(named), list(plain));
  for (const file of list(plain)) {
    assert.equal(readFileSync(join(named, file), "utf8"), readFileSync(join(plain, file), "utf8"), file);
  }
  for (const file of ["AGENTS.md", "CLAUDE.md", "tsconfig.json", ".mcp.json:.mcp.json", "context/about-you.md", "src/agent/about-you/skill.tsx", "src/agent/how-this-works/skill.tsx"]) {
    const [shipped, written = shipped] = file.split(":");
    assert.equal(readFileSync(join(plain, written), "utf8"), readFileSync(join(template, shipped), "utf8"), file);
  }
  assert.match(readFileSync(join(plain, "AGENTS.md"), "utf8"), /starts as Juno, a demo assistant/);
});

// The booking agent's numbers: B-1, B-2, cancel B-1, then a new booking must not reuse B-2.
// Node 22.12 strips types only behind a flag, so the pure module runs in a child process.
test("booking numbers are never reused after a cancellation", () => {
  const module = new URL("../templates/booking/src/agent/calendar.ts", import.meta.url).href;
  const script = `
    import { addAppointment, removeAppointment } from ${JSON.stringify(module)};
    const input = { service: "haircut", date: "2030-01-01", time: "09:00", name: "A" };
    let book = { appointments: [], nextNumber: 1 };
    const ids = [];
    const add = () => { const r = addAppointment(book, input); book = r.book; ids.push(r.created.id); };
    add(); add();
    book = removeAppointment(book, "B-1").book;
    add();
    const ids3 = book.appointments.map((a) => a.id);
    const gone = removeAppointment(book, "B-2");
    console.log(JSON.stringify({ ids, ids3, afterCancelB2: gone.book.appointments.map((a) => a.id), removed: gone.removed }));
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ids: ["B-1", "B-2", "B-3"], ids3: ["B-2", "B-3"], afterCancelB2: ["B-3"], removed: true });
});
