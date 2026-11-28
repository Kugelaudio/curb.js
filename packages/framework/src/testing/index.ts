/**
 * `curb/testing`: everything to test a voice agent and improve it from real calls, in text, in
 * three layers. Each is plain functions and plain data; `curb test` and `curb review` are built
 * from the first two with these same exports.
 *
 * Layer 1, the foundation: a call of the agent driven from any code (`startCall`), the one record
 * every conversation is held in (`loadCalls`, `loadRun`, `saveRun`), a model to think with
 * (`testModel`), many at once (`inParallel`), results for CI (`report`), and the host they run
 * on (`projectHost`).
 *
 * Layer 2, building blocks: callers (`simulatedCaller`, `scriptedCaller`, `personas`, from a
 * real call `callerFromCall`, `replayCall`, and for an agent with no calls yet `callersFor`), a
 * whole conversation (`converse`), checks of one
 * (`builtInChecks`, `checksOf`), the judge (`judge`, `ask`, `FINDINGS`, and how far to trust it,
 * `judgeAgreement`), numbers across many (`styleNumbers`, `passRate`, `groupFindings`), and
 * whether a change helped (`compareRuns`, `compare`).
 *
 * Layer 3, the ready-made path: `scenario()` files that `curb test` runs, and the hooks of a
 * call (`runHook`, `buildCallEvent`).
 *
 *   // src/agent/booking.scenario.ts
 *   import { personas, scenario } from "curb/testing";
 *   export default scenario({
 *     caller: { goal: "Book a follow-up call for next week", knows: "Name Max Mustermann", ...personas.rushed },
 *     expectations: ["The agent reads the day and time back before it books."],
 *     expect: ({ called }) => [called("book_meeting")],
 *   });
 *
 * See docs/agent-guide/testing.md and docs/agent-guide/testing-api.md.
 */

// Layer 1.
export { startCall, type Call } from "./call.js";
export { loadCalls } from "./load-calls.js";
export { loadRun, saveRun, type ConversationRecord, type TestRun } from "./record.js";
export { testModel, type TestModel } from "./model.js";
export { inParallel } from "./parallel.js";
export { passRate, report, type ReportGroup } from "./results.js";
export { projectHost, type TestHost } from "./host.js";

// Layer 2.
export { converse, scriptedCaller, simulatedCaller, type Caller } from "./converse.js";
export { builtInChecks, checksOf } from "./checks.js";
export { FINDINGS, ask, judge, type Finding } from "./judge.js";
export { styleNumbers } from "./style.js";
export { groupFindings } from "./review.js";
export { personas } from "./personas.js";
export { callerFromCall, replayCall } from "./from-call.js";
export { callersFor } from "./callers.js";
export { compare, compareRuns, type RunComparison, type SideBySide } from "./compare.js";
export { judgeAgreement, type JudgeAgreement } from "./agreement.js";
export { affectedScenarios, type AffectedScenario } from "./changed.js";

// Layer 3.
export { fake, scenario } from "./scenario.js";
export { localReplyStore, remoteReplyStore, withReplyStore, type ReplyStore, type StoredReply } from "./reply-store.js";
export { buildCallEvent, runHook } from "./hooks.js";
export type {
  CallerBehaviour,
  CallerPersona,
  ExpectedCall,
  JudgeFinding,
  Scenario,
  ScenarioCaller,
  ScenarioCheck,
  ScenarioConfirmation,
  ScenarioCallOptions,
  ScenarioDefinition,
  ScenarioEvidence,
  ScenarioExpectContext,
  ScenarioFake,
  ScenarioFakeEntry,
  ScenarioRunResult,
  ScenarioSkill,
  ScenarioStart,
  ScenarioStartInfo,
  ScenarioTool,
  ScenarioToolCall,
  ScenarioTurn,
  ScenarioTurnError,
  StyleLimits,
  StyleMetric,
} from "./scenario.js";
