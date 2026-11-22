import { personas, scenario } from "curb/testing";

/**
 * A simulated caller with a goal: `curb test` plays the caller on a second model, and a judge
 * reads the finished call. The persona makes the caller harder than the default one, who is
 * more patient and clearer than the people who really call.
 *
 * The checks say what must be true when the call is over, not which way the agent took there:
 * Lena may offer slots in one question or in three. Either way one haircut for Alex is in the
 * calendar at the end.
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
  // Every run runs the agent's tools for real. Here they only change this call's own calendar.
  // A tool that writes to a real calendar gets a fake:
  // fakes: { book_appointment: { ok: true, message: "Booked as B-1." } }
  // A judge answers each sentence with yes, no or unknown, and quotes the turn that shows it.
  expectations: ["The agent says the appointment is booked only after its book_appointment call succeeded."],
  // The agent's state at the end of the call: one haircut for Alex, and nothing else.
  expect: ({ stateMatches }) => [stateMatches("lena", { appointments: [{ service: "haircut", name: /alex/i }] })],
});
