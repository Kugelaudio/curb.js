import { scenario } from "curb/testing";

export const verifiedFirst = scenario({
  name: "the contract skill opens only after the customer is verified",
  turns: ["My customer number is 4711, which plan am I on?"],
  expect: ({ called, said }) => [called("verify_customer"), said(/green 12/i)],
});

export const toAPerson = scenario({
  name: "a person is reached with a note",
  turns: ["My customer number is 4711", "I need to speak to a person about a wrong invoice"],
  fakes: { hand_to_advisor: { ok: true, message: "The advisor has the call." } },
  expect: ({ called }) => [called("verify_customer"), called("hand_to_advisor")],
});
