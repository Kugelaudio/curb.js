/**
 * `curb/testing`: conversation scenarios that `curb test` runs headlessly.
 *
 *   // src/agent/booking.scenario.ts
 *   import { personas, scenario } from "curb/testing";
 *   export default scenario({
 *     caller: { goal: "Book a follow-up call for next week", knows: "Name Max Mustermann", ...personas.rushed },
 *     expectations: ["The agent reads the day and time back before it books."],
 *     expect: ({ called }) => [called("book_meeting")],
 *   });
 *
 * `personas` is a small library of callers. `runHook` runs an agent's `afterCall` or
 * `afterEvaluation` on a call, and `buildCallEvent` builds the event from the few fields a test
 * cares about.
 *
 * See docs/agent-guide/testing.md.
 */
export { scenario } from "./scenario.js";
export { personas } from "./personas.js";
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
  ScenarioDefinition,
  ScenarioEvidence,
  ScenarioExpectContext,
  ScenarioFake,
  ScenarioToolCall,
  ScenarioTurn,
  ScenarioTurnError,
  StyleLimits,
  StyleMetric,
} from "./scenario.js";
