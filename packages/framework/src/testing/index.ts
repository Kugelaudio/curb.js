/**
 * `curb/testing`: conversation scenarios that `curb test` runs headlessly.
 *
 *   // src/agent/booking.scenario.ts
 *   import { scenario } from "curb/testing";
 *   export default scenario({
 *     caller: { goal: "Book a follow-up call for next week", knows: "Name Max Mustermann" },
 *     expect: ({ called }) => [called("book_meeting")],
 *   });
 *
 * See docs/agent-guide/testing.md.
 */
export { scenario } from "./scenario.js";
export type {
  Scenario,
  ScenarioCaller,
  ScenarioCheck,
  ScenarioConfirmation,
  ScenarioDefinition,
  ScenarioExpectContext,
  ScenarioFake,
  ScenarioToolCall,
  ScenarioTurn,
  ScenarioTurnError,
} from "./scenario.js";
