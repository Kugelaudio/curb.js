/**
 * AGENT_LITERAL_DATE: a calendar date written into text the model reads.
 *
 * Every request to the model carries today's date (in the agent's `timeZone`), so a date written
 * into the prompt goes stale or misleads: "Heute ist der 3. Oktober" still says the third of
 * October on every later call, and "our next opening is October 28" outlives the 28th. A date
 * that never changes, such as a public holiday, can be meant, so this is a warning.
 *
 * Scanned is what the model reads, from the agent rendered with every skill loaded: the system
 * prompt; every instruction, text and `<Text src>` document; every skill link's description;
 * every tool's description and each `description` in its fields' JSON Schema; and a fixed
 * `firstTurn: { say }` line. Code comments, `defineAgent({ preview })` and a tool's `tryWith`
 * never reach the model, so they are not scanned. An MCP server's tools are that server's text,
 * not the project's, and are skipped.
 *
 * A date is reported only where it is written: in the agent's file, in the file of the skill
 * that shows it, or in the document itself. A date code computes while rendering
 * (`new Intl.DateTimeFormat(...).format(new Date())`) is in what the model reads but in no file,
 * so it is never reported.
 */

import {
  AUTHORING_DIAGNOSTIC_CODES,
  mergeAuthoringDiagnostics,
  type AuthoringDiagnostic,
  type AuthoringLocation,
} from "./authoring.js";
import type { AgentFirstTurn } from "./config.js";
import { normalizePublicSrc } from "./public-context.shared.js";
import { optionalStringProp, textContent } from "./semantic-node.js";
import type { SemanticNode } from "./types.js";

const MONTHS_EN = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTHS_EN_SHORT = "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const MONTHS_DE = "Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember";
// A numeric date needs a four-digit year, so a version such as 1.3.10 is not a date.
const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.\d{4}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
  new RegExp(`\\b(?:${MONTHS_EN}|${MONTHS_EN_SHORT})\\.? \\d{1,2}(?:st|nd|rd|th)?\\b`, "g"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:${MONTHS_EN})\\b`, "g"),
  new RegExp(`\\b\\d{1,2}\\. ?(?:${MONTHS_DE})\\b`, "g"),
  new RegExp(`\\b(?:${MONTHS_EN}|${MONTHS_DE}) \\d{4}\\b`, "g"),
];

// A date given as a format example: right after "e.g.", "z. B.", "for example", "zum Beispiel"
// or "like", or next to a pattern such as YYYY-MM-DD, with nothing but quotes, brackets, a colon
// or comma, and a weekday between ("for example "Tuesday, October 27th"").
const WEEKDAYS =
  "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag";
const EXAMPLE_CUE = String.raw`\be\.\s?g\.|\bz\.\s?B\.|\bfor example|\bzum Beispiel|\blike`;
const DATE_FORMAT = String.raw`\b(?:YYYY|JJJJ)-MM-(?:DD|TT)\b|\b(?:DD|TT)\.MM\.(?:YYYY|JJJJ)\b|\b(?:MM\/DD|DD\/MM)\/YYYY\b`;
const GAP = String.raw`[\s"'\`(\[:,]*(?:(?:${WEEKDAYS}),?\s*)?`;
const EXAMPLE_BEFORE = new RegExp(String.raw`(?:${EXAMPLE_CUE}|${DATE_FORMAT})${GAP}$`, "i");
const FORMAT_AFTER = new RegExp(String.raw`^[\s"'\`()\[\]:,]*(?:${DATE_FORMAT})`, "i");

/** JSON Schema keywords whose value is data, not a schema: a `description` key inside is not one. */
const VALUE_KEYWORDS = new Set(["default", "examples", "const", "enum"]);

const FIX =
  "Curb tells the model today's date on every message: leave the date out, compute it in code or get it " +
  "from a tool, and keep it only when it never changes, such as a public holiday.";

/** One warning per place the model reads and distinct date written there. */
export function diagnoseLiteralDates(options: {
  agentId: string;
  /** The agent rendered with every skill loaded. */
  tree: SemanticNode;
  /** The project-relative file `<Agent>` is written in, and its text. */
  agentFile: string;
  agentText?: string;
  /** Every skill: its module's project-relative file and text, and its `meta.description`, which a
   * `<Skill>` link without a description of its own shows the model. */
  skills: readonly { path: string; file?: string; text?: string; description?: string }[];
  firstTurn?: AgentFirstTurn;
}): AuthoringDiagnostic[] {
  const { agentId, tree, agentFile, agentText, firstTurn } = options;
  const skills = new Map(options.skills.map((skill) => [skill.path, skill]));
  const diagnostics: AuthoringDiagnostic[] = [];
  /** `written`: the texts a date must appear in, as rendered, to be reported. */
  const scan = (where: string, location: AuthoringLocation, text: string, written: readonly (string | undefined)[]) => {
    for (const date of literalDates(text)) {
      if (!written.some((source) => source?.includes(date))) continue;
      diagnostics.push({
        code: AUTHORING_DIAGNOSTIC_CODES.literalDate,
        severity: "warning",
        message: `${where} writes the date "${date}" into what the model reads.`,
        location: { agentId, ...location },
        fix: FIX,
      });
    }
  };

  /** A place at the agent level (null) or in skill `path`: how it is named, where it is
   * located, and the files a date in it must be written in, the agent's and the skill's own. */
  const placeIn = (path: string | null) => {
    const skill = path === null ? undefined : skills.get(path);
    return {
      owner: path === null ? "The agent" : `Skill ${path}`,
      at: (component: string): AuthoringLocation =>
        path === null ? { source: agentFile, component } : { skillPath: path, source: skill?.file, component },
      written: [agentText, skill?.text],
    };
  };

  /** Each node as the compiler reads it: a prose node's text is one whole, never its pieces. */
  const visit = (node: SemanticNode, current: string | null): void => {
    const path = node.type === "agent-page" && typeof node.props.path === "string" ? node.props.path : current;
    const { owner, at, written } = placeIn(path);
    switch (node.type) {
      case "agent-system-prompt":
        // Inside a skill, the compiler reads it as that skill's text.
        scan(path === null ? "The system prompt" : `${owner}'s text`, at("SystemPrompt"), textContent(node), written);
        return;
      case "agent-instruction":
        scan(`${owner}'s instruction`, at("Instruction"), textContent(node), written);
        return;
      case "agent-text":
      case "agent-text-node":
        scan(`${owner}'s text`, at("Text"), textContent(node), written);
        // A <Skill> written inside the text is a link of its own.
        for (const child of node.children) if (child.type === "agent-skill") visit(child, path);
        return;
      case "agent-context-doc": {
        const src = optionalStringProp(node, "src");
        if (!src) return;
        const file = `context/${normalizePublicSrc(src)}`;
        const content = optionalStringProp(node, "content") ?? "";
        // The document is its own text: every date in it is written there.
        scan(`${owner}'s document ${file}`, { ...at(`Text src=${JSON.stringify(src)}`), source: file }, content, [content]);
        return;
      }
      case "agent-skill": {
        const to = optionalStringProp(node, "to");
        const description = optionalStringProp(node, "description");
        if (!to || !description) return;
        // A link without a description of its own shows the target skill's meta.description,
        // written in that skill's file.
        if (skills.get(to)?.description === description) {
          const meta = placeIn(to);
          scan(`Skill ${to}'s description`, meta.at("meta"), description, meta.written);
        } else {
          scan(`Skill ${to}'s description`, at(`Skill path=${JSON.stringify(to)}`), description, written);
        }
        return;
      }
      case "agent-tool":
      case "agent-form": {
        const name = optionalStringProp(node, "name");
        // An MCP server's tool is that server's text, not the project's.
        if (!name || optionalStringProp(node, "id")?.startsWith("mcp:")) return;
        const location = at(`Tool name=${JSON.stringify(name)}`);
        scan(`Tool ${name}'s description`, location, optionalStringProp(node, "description") ?? "", written);
        for (const { field, text } of fieldDescriptions(node)) {
          scan(`Tool ${name}'s field ${field}`, location, text, written);
        }
        return;
      }
      case "agent-error":
        // A tool's or an MCP server's error while the agent runs, not text the project wrote.
        return;
    }
    for (const child of node.children) visit(child, path);
  };
  visit(tree, null);

  const say = typeof firstTurn === "object" ? firstTurn.say : undefined;
  if (typeof say === "string") {
    scan("The opening line", { source: agentFile, component: "defineAgent" }, say, [agentText]);
  }
  return mergeAuthoringDiagnostics(diagnostics);
}

/**
 * The dates written in `text`, each once and as written. Matches that overlap are one date
 * ("3. Oktober 2026" matches as "3. Oktober" and as "Oktober 2026"), and a date given as a format
 * example is none.
 */
function literalDates(text: string): string[] {
  const spans = DATE_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length] as const),
  ).sort(([left], [right]) => left - right);
  const dates = new Set<string>();
  let start = -1;
  let end = -1;
  const keep = () => {
    if (start >= 0 && !isFormatExample(text, start, end)) dates.add(text.slice(start, end));
  };
  for (const [from, to] of spans) {
    if (from < end) {
      end = Math.max(end, to);
      continue;
    }
    keep();
    [start, end] = [from, to];
  }
  keep();
  return [...dates];
}

function isFormatExample(text: string, start: number, end: number): boolean {
  return EXAMPLE_BEFORE.test(text.slice(0, start)) || FORMAT_AFTER.test(text.slice(end));
}

/** Each `description` the model reads in a tool's fields, with the field it describes:
 * `address.city` for a property of a nested object, `items[]` for a list's items. */
function fieldDescriptions(tool: SemanticNode): { field: string; text: string }[] {
  const found: { field: string; text: string }[] = [];
  for (const field of tool.children) {
    const name = field.type === "agent-field" ? optionalStringProp(field, "name") : undefined;
    // A `<Tool schema>` field is zod's JSON Schema of it; a `<Field>` has its description alone.
    if (name) schemaDescriptions(field.props.jsonSchema ?? { description: field.props.description }, name, found);
  }
  return found;
}

function schemaDescriptions(schema: unknown, field: string, found: { field: string; text: string }[]): void {
  if (Array.isArray(schema)) {
    for (const branch of schema) schemaDescriptions(branch, field, found);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") found.push({ field, text: value });
    else if (key === "properties" && value && typeof value === "object") {
      for (const [name, property] of Object.entries(value)) schemaDescriptions(property, `${field}.${name}`, found);
    } else if (key === "items" || key === "prefixItems") schemaDescriptions(value, `${field}[]`, found);
    else if (!VALUE_KEYWORDS.has(key)) schemaDescriptions(value, field, found);
  }
}
