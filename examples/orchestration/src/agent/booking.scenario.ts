import { fake, scenario } from "curb/testing";
import { bookViewing } from "./booking/tools.js";

// The fake has the type of what bookViewing's onSubmit returns, so `curb check` refuses one of
// another shape. Faked, the tool still asks its confirm question and books only on a yes.
const booked = fake(bookViewing, (input) => ({ ok: true as const, data: input }));

export default scenario({
  name: "books only after the steps and the caller's yes",
  turns: ["I would like to view the flat", "Sam Weber", "Tuesday at ten works", "Yes, that's right"],
  fakes: [booked],
  expect: ({ called }) => [called("finish_step"), called(bookViewing)],
});

export const noYesNoBooking = scenario({
  name: "does not book on a no",
  turns: ["I would like to view the flat", "Sam Weber", "Tuesday at ten works", "No, not that day"],
  fakes: [booked],
  expect: ({ notCalled }) => [notCalled(bookViewing)],
});
