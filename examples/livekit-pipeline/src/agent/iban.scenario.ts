import { scenario } from "curb/testing";

export default scenario({
  name: "the agent gives the IBAN",
  turns: ["What is your IBAN?"],
  expect: ({ said }) => [said(/DE00/)],
});
