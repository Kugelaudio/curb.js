import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunRequest } from "../llm/types.js";
import { isJudgeRequest, judgeAnswer } from "../test-fixtures/conversations.js";
import { says, steps, tasksBundle } from "../test-fixtures/tasks.js";
import type { ReviewReport } from "./review-report.js";
import { reviewCommand } from "./review.js";
import { createTestProject } from "./test-project.js";
import type { TestHost } from "./test.js";

/** `curb review` in a project whose scenarios give findings of their own. Hermetic: every
 * model request is answered here. */

type Answers = NonNullable<Parameters<typeof judgeAnswer>[1]>;

const asked = (request: AgentRunRequest) => [...request.systemPrompt.matchAll(/^- ([a-z_0-9]+): /gm)].map((match) => match[1]);

const NATURAL = `export const natural = {
  canned_closing: 'The agent ends a reply with a stock line such as "Is there anything else I can help you with?"',
  missed_mood: "The caller sounded annoyed or rushed and the agent carried on as if they had not.",
};
`;

describe("curb review asks a project's own findings", () => {
  const projects: string[] = [];
  afterEach(() => {
    for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const exported = (callId: string) =>
    JSON.stringify({
      callId,
      startedAt: "2030-03-04T09:00:00.000Z",
      endReason: "caller_ended",
      transcript: { turns: [{ speaker: "caller", text: "Please move my appointment to Friday." }, { speaker: "agent", text: "Done. Anything else?" }] },
    });
  const scenarioWith = (findings: string) => `import { scenario } from "curb/testing";
export default scenario({ turns: ["Hi"], findings: ${findings} });
`;

  async function review(files: Record<string, string>, judgeAnswers: Answers = {}) {
    const root = createTestProject({ "calls.jsonl": `${exported("c-1")}\n${exported("c-2")}\n`, ...files });
    projects.push(root);
    const requests: AgentRunRequest[] = [];
    const testHost: TestHost = {
      async createBundle() {
        return tasksBundle(steps([]));
      },
      simulator: () => async (request) => {
        requests.push(request);
        return says(isJudgeRequest(request) ? judgeAnswer(request, judgeAnswers) : JSON.stringify({ patterns: [] }));
      },
    };
    const out: string[] = [];
    const code = await reviewCommand(["calls.jsonl", "--json"], root, { host: testHost, out: (text) => void out.push(text), progress: () => {} });
    return { code, report: JSON.parse(out.join("")) as ReviewReport, requests };
  }

  it("asks every call the findings the project's scenarios give, and the grouping knows their sentences", async () => {
    const shared = { "src/agent/natural.ts": NATURAL };
    const { code, report, requests } = await review(
      {
        ...shared,
        "src/agent/a.scenario.ts": `import { scenario } from "curb/testing";\nimport { natural } from "./natural.js";\nexport default scenario({ turns: ["Hi"], findings: natural });\n`,
        "src/agent/b.scenario.ts": `import { scenario } from "curb/testing";\nimport { natural } from "./natural.js";\nexport default scenario({ turns: ["Hello"], findings: natural });\n`,
      },
      { canned_closing: { answer: "yes", turn: 1, quote: "Anything else?", reason: "A stock closing line." } },
    );

    expect(code).toBe(0);
    const judgedRequests = requests.filter(isJudgeRequest);
    expect(judgedRequests.map((request) => asked(request).slice(-3))).toEqual([
      ["unresolved", "canned_closing", "missed_mood"],
      ["unresolved", "canned_closing", "missed_mood"],
    ]);
    const grouping = requests.find((request) => !isJudgeRequest(request))!;
    expect(grouping.systemPrompt).toContain('- canned_closing: The agent ends a reply with a stock line such as "Is there anything else I can help you with?"');
    expect(report.patterns.map((pattern) => [pattern.title, pattern.calls, pattern.kinds])).toEqual([[expect.stringContaining("The agent ends a reply with a stock line"), 2, ["canned_closing"]]]);
  });

  it("refuses one id with two sentences in two scenario files, naming both", async () => {
    await expect(
      review({
        "src/agent/a.scenario.ts": scenarioWith(`{ canned_closing: "The agent ends on a stock line." }`),
        "src/agent/b.scenario.ts": scenarioWith(`{ canned_closing: "The agent closes every reply the same way." }`),
      }),
    ).rejects.toThrow(
      '[CURB_REVIEW_FINDING_CONFLICT] The finding "canned_closing" is given two sentences: "The agent ends on a stock line." in src/agent/a.scenario.ts, and "The agent closes every reply the same way." in src/agent/b.scenario.ts.',
    );
  });

  it("asks what it always asked when no scenario gives findings", async () => {
    const { requests } = await review({ "src/agent/a.scenario.ts": `import { scenario } from "curb/testing";\nexport default scenario({ turns: ["Hi"] });\n` });
    expect(requests.filter(isJudgeRequest).map((request) => asked(request).at(-1))).toEqual(["unresolved", "unresolved"]);
  });
});
