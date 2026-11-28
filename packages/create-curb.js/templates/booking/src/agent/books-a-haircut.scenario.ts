import { personas, scenario } from "curb/testing";
import { bookingFakes } from "./fakes.js";

/**
 * A simulated caller with a goal: `curb test` plays the caller on a second model, and a judge
 * reads the finished call. The persona makes the caller harder than the default one, who is
 * more patient and clearer than the people who really call.
 *
 * The checks say what must be true when the call is over, not which way the agent took there:
 * Lena may offer slots in one question or in three. Either way she books one haircut for Alex.
 */
export default scenario({
  name: "books a haircut on a bad line",
  caller: {
    goal: "Book a haircut on the next day the studio is open, at a free time the agent offers.",
    knows: "Your name is Alex Example. You want a haircut. Any free time of day suits you.",
    ...personas.hardOfHearing,
  },
  // A model does not answer the same way twice, so this scenario runs three times and passes
  // when two of the three do. The report still shows the rate and marks it flaky when a run
  // failed. Raise minPassRate toward 1 (every run) once it passes every time for a while;
  // a scripted scenario needs neither: the same words run once and must pass.
  runs: 3,
  minPassRate: 0.66,
  // A fake answers in place of each tool, so no run reaches a real booking system.
  fakes: bookingFakes,
  // A judge answers each sentence with yes, no or unknown, and quotes the turn that shows it.
  expectations: ["The agent says the appointment is booked only after its book_appointment call succeeded."],
  // One haircut for Alex. A fake books nothing for real, so the check reads the call.
  expect: ({ called }) => [called("book_appointment", { service: "haircut", name: /alex/i })],
});
