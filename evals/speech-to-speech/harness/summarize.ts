/**
 * The eval's results as Markdown: one table per capability (skill found, navigation, tool calls)
 * with rates and n for each path, then turns, latency, what the model heard, and every case side
 * by side.
 *
 *   npx tsx harness/summarize.ts <results dir>
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseScore, EvalPath } from "./score.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: summarize.ts <results dir>");
const all: CaseScore[] = readdirSync(dir)
  .filter((name) => /\.(text|voice)\.json$/.test(name))
  .flatMap((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as CaseScore[]);
const paths = (["text", "voice"] as const).filter((path) => all.some((score) => score.path === path));
const scored = (path: EvalPath) => all.filter((score) => score.path === path && score.error === null);

const pct = (part: number, whole: number) => (whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`);
const rate = (values: boolean[]) => `${pct(values.filter(Boolean).length, values.length)} (${values.filter(Boolean).length}/${values.length})`;
const quantile = (values: number[], q: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const ms = (value: number | null) => (value === null ? "n/a" : `${(value / 1000).toFixed(1)} s`);
const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");

const lines: string[] = ["# Speech-to-speech eval results", ""];
lines.push(
  table(
    ["Path", "Conversations", "Scored", "Errors"],
    paths.map((path) => {
      const of = all.filter((score) => score.path === path);
      return [path, String(of.length), String(of.filter((score) => score.error === null).length), String(of.filter((score) => score.error !== null).length)];
    }),
  ),
  "",
);

/** Rows by `group` for a boolean metric, one column per path. */
function metricTable(metric: (score: CaseScore) => boolean | null, groups: Array<[string, (score: CaseScore) => boolean]>): string {
  return table(
    ["", ...paths],
    groups.map(([label, keep]) => [
      label,
      ...paths.map((path) => rate(scored(path).filter(keep).flatMap((score) => (metric(score) === null ? [] : [metric(score)!])))),
    ]),
  );
}
const languages = [...new Set(all.map((score) => score.language))].sort();
const kinds = [...new Set(all.map((score) => score.kind))];
const groupsFor = (metric: (score: CaseScore) => boolean | null): Array<[string, (score: CaseScore) => boolean]> => [
  ["all", () => true],
  ...languages.map((language): [string, (score: CaseScore) => boolean] => [`language ${language}`, (score) => score.language === language]),
  ...kinds
    .filter((kind) => all.some((score) => score.kind === kind && metric(score) !== null))
    .map((kind): [string, (score: CaseScore) => boolean] => [`kind ${kind}`, (score) => score.kind === kind]),
];

lines.push("## 1. Finds the right skill", "", "The first skill the agent reads is the one the caller's request needs.", "");
lines.push(metricTable((score) => score.skillFound, groupsFor((score) => score.skillFound)), "");
lines.push("## 2. Navigates between skills", "", "Every skill the call needs is reached, and no skill it does not need is read (cases that move between skills).", "");
lines.push(metricTable((score) => score.navigationOk, groupsFor((score) => score.navigationOk)), "");

lines.push("## 3. Calls the right tools", "", "Per conversation: every expected tool ran with the expected arguments, no other business tool was called, nothing forbidden ran. Precision and recall over tool names, summed over conversations.", "");
lines.push(
  table(
    ["", ...paths],
    [
      ["all tools correct", ...paths.map((path) => rate(scored(path).map((score) => score.toolsOk)))],
      ...languages.map((language) => [`all tools correct, ${language}`, ...paths.map((path) => rate(scored(path).filter((score) => score.language === language).map((score) => score.toolsOk)))]),
      ["precision", ...paths.map((path) => {
        const tp = scored(path).reduce((sum, score) => sum + score.tp.length, 0);
        const fp = scored(path).reduce((sum, score) => sum + score.fp.length, 0);
        return `${pct(tp, tp + fp)} (${tp}/${tp + fp})`;
      })],
      ["recall", ...paths.map((path) => {
        const tp = scored(path).reduce((sum, score) => sum + score.tp.length, 0);
        const fn = scored(path).reduce((sum, score) => sum + score.fn.length, 0);
        return `${pct(tp, tp + fn)} (${tp}/${tp + fn})`;
      })],
      ["called with wrong arguments", ...paths.map((path) => {
        const tp = scored(path).reduce((sum, score) => sum + score.tp.length, 0);
        const wrong = scored(path).reduce((sum, score) => sum + score.argErrors.length, 0);
        return `${pct(wrong, tp)} (${wrong}/${tp})`;
      })],
      ["conversations where a forbidden tool ran", ...paths.map((path) => rate(scored(path).map((score) => score.forbiddenRan.length > 0)))],
    ],
  ),
  "",
);
lines.push("By kind, all tools correct:", "", metricTable((score) => score.toolsOk, groupsFor((score) => score.toolsOk)).split("\n").filter((row) => !row.includes("| language")).join("\n"), "");

lines.push("## Turns and latency", "");
lines.push(
  table(
    ["", ...paths],
    [
      ["caller turns per call, mean", ...paths.map((path) => {
        const turns = scored(path).map((score) => score.callerTurns);
        return turns.length ? (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1) : "n/a";
      })],
      ["per turn, p50 / p90 (text: the turn; voice: to first audio)", ...paths.map((path) => {
        const values = scored(path).flatMap((score) => score.latenciesMs);
        return `${ms(quantile(values, 0.5))} / ${ms(quantile(values, 0.9))} (n=${values.length})`;
      })],
      ["voice: to the answer after Curb's turn, p50 / p90", ...paths.map((path) => {
        if (path !== "voice") return "";
        const values = scored(path).flatMap((score) => score.answerMs ?? []);
        return `${ms(quantile(values, 0.5))} / ${ms(quantile(values, 0.9))} (n=${values.length})`;
      })],
    ],
  ),
  "",
);

if (paths.includes("voice")) {
  const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  const distance = (a: string[], b: string[]) => {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const kept = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = kept;
      }
    }
    return row[b.length]!;
  };
  const heard = scored("voice").flatMap((score) => (score.heard ?? []).map((line) => ({ ...line, language: score.language })));
  lines.push("## What the speech model heard (voice)", "", "Word error rate of the model's transcript of each caller line against the line the caller's voice said (digits and number words count as different words, so numbers inflate it).", "");
  lines.push(
    table(
      ["", "lines", "nothing heard", "word error rate"],
      ["all", ...languages].map((language) => {
        const of = heard.filter((line) => language === "all" || line.language === language);
        const errors = of.reduce((sum, line) => sum + distance(words(line.said), words(line.heard ?? "")), 0);
        const total = of.reduce((sum, line) => sum + words(line.said).length, 0);
        return [language, String(of.length), String(of.filter((line) => line.heard === null).length), pct(errors, total)];
      }),
    ),
    "",
  );
}

lines.push("## Every case", "");
const cases = [...new Map(all.map((score) => [`${score.agent}|${score.case}`, score])).values()];
lines.push(
  table(
    ["Agent", "Case", "Kind", ...paths.flatMap((path) => [`${path} skill`, `${path} nav`, `${path} tools`])],
    cases.map((one) => [
      one.agent,
      one.case,
      one.kind,
      ...paths.flatMap((path) => {
        const runs = scored(path).filter((score) => score.agent === one.agent && score.case === one.case);
        const cell = (metric: (score: CaseScore) => boolean | null) => {
          const values = runs.flatMap((score) => (metric(score) === null ? [] : [metric(score)!]));
          return values.length ? `${values.filter(Boolean).length}/${values.length}` : "–";
        };
        return [cell((score) => score.skillFound), cell((score) => score.navigationOk), cell((score) => score.toolsOk)];
      }),
    ]),
  ),
  "",
);

const markdown = lines.join("\n");
writeFileSync(join(dir, "summary.md"), `${markdown}\n`);
process.stdout.write(`${markdown}\n`);
