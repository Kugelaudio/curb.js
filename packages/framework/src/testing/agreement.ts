import { FINDINGS, callName, judge, type JudgeModel } from "./judge.js";
import { testModel } from "./model.js";
import { inParallel } from "./parallel.js";
import type { ConversationRecord } from "./record.js";

/**
 * How far to trust the judge on a team's own findings: calls a person labelled, judged again,
 * and the judge's answers counted against the labels.
 */

/** Per finding: of the labelled calls that have it, how many the judge caught; of those that do
 * not, how many it flagged anyway; and the calls on which it disagreed with the label. */
export type JudgeAgreement = {
  findings: Array<{
    id: string;
    withIt: { caught: number; calls: number };
    withoutIt: { flagged: number; calls: number };
    disagreements: string[];
  }>;
  /** Labelled calls the judge could not be asked about, with why. */
  notJudged: Array<{ record: string; reason: string }>;
  /** The judge's model as `provider:model`, or null when the host did not say. */
  model: string | null;
};

/**
 * Judge every record `labels` names, and count the judge's findings against the labels. `labels`
 * maps a record's id (as a report names it: its `id`, else "<scenario> run <n>") to findings by
 * id, `true` when the call has it and `false` when it does not; a finding left out of a label is
 * not counted for that call. The judge asks `findings` (default {@link FINDINGS}), which must hold
 * every labelled finding, on `model` (default `testModel()`). Throws, before any request, on a
 * label for a record that is not given or for a finding that is not asked.
 */
export async function judgeAgreement(params: {
  records: readonly ConversationRecord[];
  labels: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  findings?: Readonly<Record<string, string>>;
  model?: JudgeModel;
}): Promise<JudgeAgreement> {
  const findings = params.findings ?? FINDINGS;
  const byName = new Map(params.records.map((record) => [callName(record), record]));
  const missing = Object.keys(params.labels).filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`judgeAgreement(): no record is named ${missing.map((name) => JSON.stringify(name)).join(", ")}. The records are: ${[...byName.keys()].join(", ") || "none"}.`);
  }
  const wrong = Object.entries(params.labels).flatMap(([name, label]) => Object.entries(label).flatMap(([id, value]) => (typeof value === "boolean" ? [] : [`${name}: ${id}`])));
  if (wrong.length > 0) throw new Error(`judgeAgreement(): a label is true (the call has the finding) or false (it does not); not so for ${wrong.join(", ")}.`);
  const ids = [...new Set(Object.values(params.labels).flatMap((label) => Object.keys(label)))];
  const unasked = ids.filter((id) => !Object.hasOwn(findings, id));
  if (unasked.length > 0) {
    throw new Error(`judgeAgreement(): ${unasked.join(", ")} ${unasked.length === 1 ? "is" : "are"} labelled but not asked. Fix: add ${unasked.length === 1 ? "it" : "them"} to findings, as { ...FINDINGS, id: "one sentence" }.`);
  }
  const model: JudgeModel = params.model ?? (await testModel());
  const names = Object.keys(params.labels);
  const judged = await inParallel(
    names,
    async (name): Promise<{ name: string; found: Set<string> } | { name: string; reason: string }> => {
      try {
        const found = new Set((await judge(byName.get(name)!, { findings, model })).findings.map((finding) => finding.kind));
        return { name, found };
      } catch (error) {
        return { name, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    { concurrency: 4 },
  );
  return {
    findings: ids.map((id) => {
      const withIt = { caught: 0, calls: 0 };
      const withoutIt = { flagged: 0, calls: 0 };
      const disagreements: string[] = [];
      for (const result of judged) {
        const label = params.labels[result.name]![id];
        if (!("found" in result) || label === undefined) continue;
        const flagged = result.found.has(id);
        if (label) Object.assign(withIt, { calls: withIt.calls + 1, caught: withIt.caught + (flagged ? 1 : 0) });
        else Object.assign(withoutIt, { calls: withoutIt.calls + 1, flagged: withoutIt.flagged + (flagged ? 1 : 0) });
        if (flagged !== label) disagreements.push(result.name);
      }
      return { id, withIt, withoutIt, disagreements };
    }),
    notJudged: judged.flatMap((result) => ("reason" in result ? [{ record: result.name, reason: result.reason }] : [])),
    model: model.model ?? null,
  };
}
