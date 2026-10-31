import { scenario } from "curb/testing";

export default scenario({
  name: "ein Autounfall geht in die Sparte Kfz",
  caller: {
    goal: "Einen Unfall mit dem eigenen Auto melden und am Ende die Vorgangsnummer erfahren",
    knows:
      "Name Max Beispiel. Kennzeichen B-MB 1972. Heute Morgen auf der A100 in Berlin ist jemand beim Spurwechsel " +
      "in die Fahrerseite gefahren. Niemand ist verletzt, das Auto steht auf dem Seitenstreifen. " +
      "Gegenseite: Kennzeichen P-XY 88. Die Polizei hat aufgenommen, Tagebuchnummer 4711.",
    language: "de",
  },
  maxTurns: 16,
  expect: ({ called, said }) => [called("kfz_schaden_aufnehmen", { licensePlate: /MB\s*1972/ }), said(/SD-2026-\d{4}/)],
});
