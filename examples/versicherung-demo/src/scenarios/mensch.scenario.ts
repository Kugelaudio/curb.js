import { scenario } from "curb/testing";

export default scenario({
  name: "wer einen Menschen verlangt, wird verbunden",
  turns: ["Ich möchte sofort mit einem Menschen sprechen."],
  fakes: { verbinden_mit_berater: { ok: true, message: "Verbunden." } },
  expect: ({ called }) => [called("verbinden_mit_berater")],
});
