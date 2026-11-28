import { scenario } from "curb/testing";
import { bookingFakes } from "./fakes.js";

/**
 * Scripted caller lines: the same words on every run, so this is a gate. It runs once and must
 * pass. Keep one of these for every path that must never break.
 *
 * The price list exists only in the services skill, so a reply that states the price shows the
 * skill was read: no check needs to name the tool. The fakes keep a stray booking off any real
 * calendar.
 */
export default scenario({
  name: "answers a price question without booking",
  turns: ["Hi, what does a haircut cost?", "Okay, thanks. I will think about it."],
  fakes: bookingFakes,
  expect: ({ said, notCalled }) => [
    said(/38|thirty[- ]eight/i),
    // A question about prices books nothing.
    notCalled("book_appointment"),
  ],
});
