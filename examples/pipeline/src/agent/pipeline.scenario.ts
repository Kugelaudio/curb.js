import { scenario } from "curb/testing";

export default scenario({
  name: "a German caller moves the call to German",
  turns: ["Hallo, können wir bitte Deutsch sprechen?"],
  expect: ({ called }) => [called("switch_to_german")],
});
