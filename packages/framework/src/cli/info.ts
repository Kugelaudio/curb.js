import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { LLM_KEYS, SPEECH_KEYS, type Env } from "../provider-keys.js";
import { defaultProviderSettings, type ProviderSlot } from "../session-settings.js";
import { curbVersion } from "../version.js";
import {
  checkConfiguration,
  isNode,
  parseSource,
  projectEnvironment,
  sourceFiles,
  walk,
  type AstNode,
  type ConfigurationEntry,
  type ProviderUse,
} from "./check-env.js";
import { useHostModelKey } from "./cloud/host-model-key.js";
import { useLoginKey } from "./cloud/project-key.js";

/**
 * `curb info`: the facts a bug report needs, printed to be pasted into a public issue. So it
 * prints a variable's name and whether it is set, and nothing that came from a value: no
 * value, length or prefix, and no account from `curb login`. It runs no project code, which
 * also makes it work on a project too broken to load.
 */

const SLOTS: readonly ProviderSlot[] = ["llm", "stt", "tts"];

/** A slot's provider as the source names it; null when the source sets it in a way only
 * running the code would tell. */
type SlotProviders = Partial<Record<ProviderSlot, string | null>>;

type ProjectProviders = {
  /** The props of `<Agent>`; null when no `<Agent>` is in the source. */
  agent: SlotProviders | null;
  skills: { path: string; providers: SlotProviders }[];
};

/** The report, ready to print. Outside a project it says so and prints what it still knows. */
export async function infoReport(projectRoot: string, env: Env = process.env): Promise<string> {
  const machine = [
    "Curb:",
    `  version  ${curbVersion()}`,
    "",
    "Machine:",
    `  Node     ${process.version}`,
    `  npm      ${npmVersion()}`,
    `  OS       ${platform()} ${release()}`,
    `  arch     ${arch()}`,
    "",
  ];
  if (!existsSync(join(projectRoot, "src", "agent"))) {
    return [
      ...machine,
      "Project: none. There is no src/agent/ here, so the dependency, providers and variables are unknown.",
      "Run this from the project root to include them.",
    ].join("\n");
  }
  const providers = readProviders(projectRoot);
  const entries = await expectedVariables(projectRoot, providers, env);
  const width = Math.max(0, ...entries.map((entry) => entry.name.length));
  return [
    ...machine,
    "Project:",
    `  curb dependency  ${dependencySpec(projectRoot)}`,
    "",
    "Providers (read from the source; nothing was started):",
    ...SLOTS.map((slot) => `  ${slot.toUpperCase()}  ${describeSlot(slot, providers)}`),
    "",
    "Environment variables (names only, never values; looked up in .env and the environment):",
    ...(entries.length > 0
      ? entries.map(
          (entry) => `  ${entry.name.padEnd(width)}  ${entry.set ? "set" : "not set"}${entry.optional ? " (optional)" : ""}`,
        )
      : ["  none expected"]),
  ].join("\n");
}

/** `npm --version`, which the Windows shim runs only through a shell. */
function npmVersion(): string {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8", timeout: 10_000, shell: process.platform === "win32" });
  return result.status === 0 ? result.stdout.trim() : "not found";
}

/** The project's `curb` spec as package.json has it. A URL spec may carry a token, so it
 * loses its credentials and query. */
export function dependencySpec(projectRoot: string): string {
  let manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return "unknown (package.json cannot be read)";
  }
  const spec = manifest.dependencies?.curb ?? manifest.devDependencies?.curb;
  if (typeof spec !== "string") return "not in package.json";
  return spec.replace(/\/\/[^/]*@/, "//").replace(/\?.*$/, "");
}

/** Every `<Agent>` and `<Skill>` provider prop in the source under src/agent/. */
export function readProviders(projectRoot: string): ProjectProviders {
  const found: ProjectProviders = { agent: null, skills: [] };
  for (const file of sourceFiles(projectRoot)) {
    if (!file.startsWith("src/agent/") || !file.endsWith("x") || file.includes(".test.")) continue;
    const ast = parseSource(readFileSync(join(projectRoot, file), "utf8"), file);
    const factories = providerFactories(ast);
    walk(ast, (node) => {
      if (node.type !== "JSXOpeningElement" || !isNode(node.name) || node.name.type !== "JSXIdentifier") return;
      if (node.name.name === "Agent" && !found.agent) {
        found.agent = slotProps(node, factories);
      } else if (node.name.name === "Skill") {
        const providers = slotProps(node, factories);
        if (Object.keys(providers).length > 0) found.skills.push({ path: stringProp(node, "path") ?? "a skill", providers });
      }
    });
  }
  return found;
}

/** The local names of what the file imports from `curb/providers`, by the name exported. */
function providerFactories(ast: unknown): Map<string, string> {
  const factories = new Map<string, string>();
  walk(ast, (node) => {
    if (node.type !== "ImportDeclaration" || !isNode(node.source) || node.source.value !== "curb/providers") return;
    for (const specifier of node.specifiers as AstNode[]) {
      if (specifier.type === "ImportSpecifier" && isNode(specifier.local) && isNode(specifier.imported)) {
        factories.set(specifier.local.name as string, specifier.imported.name as string);
      }
    }
  });
  return factories;
}

function jsxAttributes(element: AstNode): AstNode[] {
  return element.attributes as AstNode[];
}

const isAttribute = (attribute: AstNode, name: string) =>
  attribute.type === "JSXAttribute" && isNode(attribute.name) && attribute.name.name === name;

function stringProp(element: AstNode, name: string): string | undefined {
  const value = jsxAttributes(element).find((attribute) => isAttribute(attribute, name))?.value;
  return isNode(value) && value.type === "StringLiteral" ? (value.value as string) : undefined;
}

function slotProps(element: AstNode, factories: ReadonlyMap<string, string>): SlotProviders {
  const providers: SlotProviders = {};
  const spread = jsxAttributes(element).some((attribute) => attribute.type === "JSXSpreadAttribute");
  for (const slot of SLOTS) {
    const attribute = jsxAttributes(element).find((candidate) => isAttribute(candidate, slot));
    if (attribute) providers[slot] = providerOf(attribute.value, slot, factories);
    // On `<Agent {...props}>` the slot may be in the spread.
    else if (spread) providers[slot] = null;
  }
  return providers;
}

/**
 * The provider of a prop that calls a factory of `curb/providers` directly: `kugelaudio.tts(…)`,
 * `anthropic("…")`. Only a provider `provider-keys.ts` knows comes back, never the call's
 * arguments, which can hold a key.
 */
function providerOf(value: unknown, slot: ProviderSlot, factories: ReadonlyMap<string, string>): string | null {
  if (!isNode(value) || value.type !== "JSXExpressionContainer" || !isNode(value.expression)) return null;
  const call = value.expression;
  if (call.type !== "CallExpression" || !isNode(call.callee)) return null;
  const { callee } = call;
  let factory: string | undefined;
  if (callee.type === "Identifier" && slot === "llm") {
    factory = factories.get(callee.name as string);
  } else if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    isNode(callee.object) &&
    callee.object.type === "Identifier" &&
    isNode(callee.property) &&
    callee.property.name === slot
  ) {
    factory = factories.get(callee.object.name as string);
  }
  if (!factory) return null;
  const provider = factory === "openaiCompatible" ? "openai-compatible" : factory;
  return Object.hasOwn(slot === "llm" ? LLM_KEYS : SPEECH_KEYS, provider) ? provider : null;
}

/** The agent level's provider of a slot, a default when `<Agent>` does not set it. */
function agentProvider(slot: ProviderSlot, { agent }: ProjectProviders): { provider: string | null; byDefault: boolean } {
  if (agent === null || agent[slot] === null) return { provider: null, byDefault: false };
  const provider = agent[slot];
  return provider ? { provider, byDefault: false } : { provider: defaultProviderSettings()[slot].provider, byDefault: true };
}

function describeSlot(slot: ProviderSlot, providers: ProjectProviders): string {
  const { provider, byDefault } = agentProvider(slot, providers);
  const skills = providers.skills.flatMap(({ path, providers: own }) =>
    slot in own ? [`${own[slot] ?? UNREAD} in ${path}`] : [],
  );
  return [`${provider ?? UNREAD}${byDefault ? " (default)" : ""}`, ...skills].join(", ");
}

const UNREAD = "set in code";

/** What the project expects from its environment, the way `curb check` finds it. The login's
 * and the host's key count as set, in a copy of the environment that is dropped here. */
async function expectedVariables(
  projectRoot: string,
  providers: ProjectProviders,
  env: Env,
): Promise<ConfigurationEntry[]> {
  const composed = { ...projectEnvironment(projectRoot, env) };
  try {
    useLoginKey(projectRoot, composed) ?? useHostModelKey(composed);
  } catch {
    // KEEP-JUSTIFIED: a damaged link or host file stops the commands that need the key, with
    // its own message. A bug report is the worst moment for this command to fail too.
  }
  const settings = (read: (slot: ProviderSlot) => string | null | undefined): ProviderUse["settings"] =>
    Object.fromEntries(SLOTS.flatMap((slot) => {
      const provider = read(slot);
      return provider ? [[slot, { provider }]] : [];
    }));
  const uses: ProviderUse[] = [
    { where: "", settings: settings((slot) => agentProvider(slot, providers).provider) },
    ...providers.skills.map(({ path, providers: own }) => ({ where: path, settings: settings((slot) => own[slot]) })),
  ];
  const { configuration } = await checkConfiguration({ projectRoot, agent: null, uses, agentId: "", env: composed });
  return [...(configuration.providers ?? []), ...configuration.code];
}
