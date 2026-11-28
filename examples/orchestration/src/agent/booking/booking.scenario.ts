import { fake, scenario } from "curb/testing";
import * as Booking from "./skill.js";
import { bookViewing } from "./tools.js";

/**
 * A test of the booking skill alone. `start` opens the skill before the first line, so the
 * caller does not have to talk the agent into it, and `now` fixes the day the agent sees: in
 * the agent's time zone (Europe/Berlin) this is a Monday morning, so "tomorrow" is a Tuesday on
 * every run, and the reply store can answer the same requests again.
 *
 * book_viewing, the one tool that would reach another system, is faked. The test is not
 * `hermetic`: the Procedure's finish_step only moves this call to its next step, and a fake of it
 * would not, so book_viewing would never appear. A hermetic run stops at finish_step instead.
 */
export default scenario({
  name: "the booking skill books tomorrow's slot",
  start: { skills: [Booking] },
  now: "2026-11-02T08:00:00Z",
  turns: ["Sam Weber", "Tomorrow at ten", "Yes, that's right"],
  fakes: [fake(bookViewing, (input) => ({ ok: true as const, data: input }))],
  expect: ({ called, opened }) => [opened(Booking), called(bookViewing, { name: "Sam Weber" })],
});
