import type { ConversationRecord, TestHost, TestRun, groupFindings, styleNumbers } from "../../testing/index.js";

/**
 * The shapes `curb test` and `curb review` work with, each read off a public type of
 * `curb/testing`: the ready-made path is built from what anyone can import.
 */

export type ScenarioEndedBy = NonNullable<ConversationRecord["ending"]["by"]>;
export type ScenarioRef = NonNullable<ConversationRecord["scenario"]>;
export type EndState = NonNullable<ConversationRecord["endState"]>;
export type RunUsage = NonNullable<ConversationRecord["usage"]>;
export type TokenUsage = NonNullable<RunUsage["agent"]>;
export type UsageRole = "agent" | "caller" | "judge";
export type ConversationEnding = ConversationRecord["ending"];

export type SavedScenarioSettings = TestRun["scenarios"][number];
export type TestModels = TestRun["models"];
export type Assessment = NonNullable<TestRun["conversations"][number]["assessment"]>;
export type RunOutcome = Assessment["outcome"];
export type RunError = NonNullable<Assessment["error"]>;
export type RunErrorKind = RunError["kind"];
export type JudgeResult = NonNullable<Assessment["judge"]>;
export type JudgeAnswer = JudgeResult["answers"][number];

/** The record of one run of a scenario, with what was made of it: what a run file holds. */
export type SavedConversation = ConversationRecord & {
  scenario: ScenarioRef;
  startedAt: string;
  ending: ConversationEnding & { by: ScenarioEndedBy };
  assessment: Assessment;
};

export type ThrottleStats = ReturnType<NonNullable<TestHost["throttle"]>["stats"]>;
export type StyleReport = ReturnType<typeof styleNumbers>;
export type StyleLimitResult = StyleReport["limits"][number];
export type ReviewPattern = Awaited<ReturnType<typeof groupFindings>>["patterns"][number];
export type ScenarioDraft = NonNullable<ReviewPattern["scenario"]>;
export type CallBundle = Awaited<ReturnType<TestHost["createBundle"]>>;
export type ExperimentDeclaration = NonNullable<CallBundle["experiments"]>[number];
