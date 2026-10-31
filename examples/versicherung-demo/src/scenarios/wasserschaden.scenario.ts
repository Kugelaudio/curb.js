import { scenario } from "curb/testing";
import { englischeAntworten } from "./deutsch.js";

export default scenario({
  name: "ein Wasserschaden wird von Anfang bis Vorgangsnummer aufgenommen",
  caller: {
    goal: "Einen Wasserschaden in der Küche melden und am Ende die Vorgangsnummer erfahren",
    knows:
      "Name Erika Mustermann. Gestern Abend ist in Berlin das Rohr unter der Spüle geplatzt. " +
      "Das Wasser ist inzwischen abgestellt, Fotos sind gemacht. Der Schaden liegt bei ungefähr 2.000 Euro. " +
      "Rückrufnummer 030 1234567.",
    language: "de",
  },
  maxTurns: 14,
  expect: ({ called, said, check, transcript }) => [
    called("sachschaden_aufnehmen", { name: /Mustermann/ }),
    said(/SD-2026-\d{4}/),
    check("alle Antworten auf Deutsch", englischeAntworten(transcript).length === 0, englischeAntworten(transcript).join(" | ")),
  ],
});
