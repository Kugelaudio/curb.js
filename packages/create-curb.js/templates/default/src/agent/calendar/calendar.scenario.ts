import { fake, scenario } from "curb/testing";
import * as Calendar from "./skill.js";
import { listEvents } from "./tools.js";

/**
 * A skill test: the call starts inside the calendar skill, so it needs no conversation to get
 * there, and its one turn is typed text. Short tests like this are cheap to keep: `curb test`
 * answers an unchanged request from its reply store, so this one calls a model again only after
 * something it sends has changed (the skill, its tool, the agent's prompt).
 *
 * The skill, the tool and the info key are values TypeScript checks: a renamed tool, a fake
 * result of the wrong shape or an info key the skill does not declare fails `curb check`.
 */
export default scenario({
  name: "reads the day's calendar",
  start: { skills: [Calendar], info: { "user.name": "Sam" } },
  spoken: false,
  // Every tool call needs a fake: a call of a tool without one ends the run as an error before
  // the tool runs, so this test never reaches a real calendar.
  hermetic: true,
  // The date the agent sees. 2026-10-30 is a Friday.
  now: "2026-10-30T08:00:00Z",
  turns: ["What's in my calendar today?"],
  // TypeScript checks the result against what list_events returns.
  fakes: [
    fake(listEvents, {
      ok: true,
      message: "1 event(s) on 2026-10-30.",
      data: { day: "2026-10-30", events: [{ time: "09:30", title: "Team stand-up" }] },
    }),
  ],
  expect: ({ called, said, opened }) => [called(listEvents, { day: "2026-10-30" }), said(/stand-up/i), opened(Calendar)],
});
