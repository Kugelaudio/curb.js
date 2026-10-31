#!/usr/bin/env node
// Checks a pull request's title and body. Merges are squashed, so the title is the commit on
// main and the changelog line. pr-rules.yml runs this on the event payload GitHub writes to
// GITHUB_EVENT_PATH, so neither text ever reaches a shell, and no message repeats them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "ci", "chore"];
export const MAX_TITLE_LENGTH = 100;

const TITLE_EXAMPLE = "feat(framework): add a hook that runs after a call";
const BODY_EXAMPLE = "## What\n\nA hook that runs after a call.\n\n## Why\n\nProjects need the transcript.";

const TITLE = new RegExp(`^(?:${TYPES.join("|")})(?:\\([^\\s()]+\\))?!?: (.+)$`);

// What pull_request_template.md puts in every pull request. The test holds the two together.
const TEMPLATE_HEADING = /^#{1,6}\s+(?:what|why|checklist)$/i;
const TEMPLATE_CHECKLIST = [
  "Tests added or updated",
  "Docs updated for anything a user can see",
  "`!` in the title if `src/public-api.txt` loses or renames a line",
];

function failure(rule, problem, example) {
  return `${rule}: ${problem}\n  valid example: ${example}`;
}

/** What is wrong with this title, one message per broken rule. */
export function titleErrors(title) {
  const errors = [];
  const fail = (rule, problem) => errors.push(failure(rule, problem, TITLE_EXAMPLE));

  if ([...title].length > MAX_TITLE_LENGTH) {
    fail("title-length", `the title is ${[...title].length} characters, the limit is ${MAX_TITLE_LENGTH}`);
  }
  const subject = TITLE.exec(title)?.[1];
  if (subject === undefined) {
    fail("title-format", `use type(scope)!: subject, where type is one of ${TYPES.join(", ")}`);
    return errors;
  }
  if (!/^\p{Ll}/u.test(subject)) fail("title-subject", "the subject must start with a lowercase letter");
  if (subject.endsWith(".")) fail("title-subject", "the subject must not end with a period");
  return errors;
}

/** The body as written by its author: no comments, template headings or template checklist. */
export function authoredBody(body) {
  return body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !TEMPLATE_HEADING.test(line) &&
        !TEMPLATE_CHECKLIST.includes(line.replace(/^[-*] \[[ xX]\] /, "")),
    )
    .join("\n");
}

/** What is wrong with this body, one message per broken rule. */
export function bodyErrors(body) {
  if (authoredBody(body ?? "")) return [];
  return [
    failure(
      "body-empty",
      "say what changes and why; comments, template headings and the checklist do not count",
      JSON.stringify(BODY_EXAMPLE),
    ),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const errors = [...titleErrors(pr.title), ...bodyErrors(pr.body)];
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exit(1);
  console.log("pr-rules: the title and body pass");
}
