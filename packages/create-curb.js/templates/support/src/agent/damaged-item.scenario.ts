import { personas, scenario } from "curb/testing";
import { supportFakes } from "./fakes.js";

/**
 * A simulated caller with a goal: `curb test` plays the caller on a second model, and a judge
 * reads the finished call. The persona makes the caller harder than the default one, who is
 * more patient and clearer than the people who really call.
 *
 * The checks say what must be true when the call is over, not which way the agent took there:
 * Mara may look the order up first or open the ticket straight from the number the caller
 * read out. Either way the agent opens one ticket for the damage.
 */
export default scenario({
  name: "opens a ticket for a damaged item",
  caller: {
    goal: "Report that the backpack from your order arrived with a torn shoulder strap, and get a support ticket opened for it.",
    knows: "Your order number is NW-1001. The trail backpack arrived with a torn shoulder strap. Your name is Sam Example.",
    ...personas.rushed,
  },
  // A model does not answer the same way twice, so this scenario runs three times and passes
  // when two of the three do. The report still shows the rate and marks it flaky when a run
  // failed. Raise minPassRate toward 1 (every run) once it passes every time for a while;
  // a scripted scenario needs neither: the same words run once and must pass.
  runs: 3,
  minPassRate: 0.66,
  // A fake answers in place of each tool, so no run reaches a real order system or ticket queue.
  fakes: supportFakes,
  // A judge answers each sentence with yes, no or unknown, and quotes the turn that shows it.
  expectations: ["The agent says a ticket is open only after its open_ticket call succeeded."],
  // One ticket about the damage. (The returns policy files a damaged item under "damaged" or
  // "return".) A fake opens no real ticket, so the check reads the call.
  expect: ({ called }) => [called("open_ticket", { category: /^(damaged|return)$/ })],
});
