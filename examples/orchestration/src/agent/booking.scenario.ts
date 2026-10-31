import { scenario } from "curb/testing";

export default scenario({
  name: "books only after the steps and the caller's yes",
  turns: ["I would like to view the flat", "Sam Weber", "Tuesday at ten works", "Yes, that's right"],
  fakes: { book_viewing: { ok: true, message: "The viewing is booked." } },
  expect: ({ called }) => [called("finish_step"), called("book_viewing")],
});

export const noYesNoBooking = scenario({
  name: "does not book on a no",
  turns: ["I would like to view the flat", "Sam Weber", "Tuesday at ten works", "No, not that day"],
  fakes: { book_viewing: { ok: true, message: "The viewing is booked." } },
  expect: ({ notCalled }) => [notCalled("book_viewing")],
});
