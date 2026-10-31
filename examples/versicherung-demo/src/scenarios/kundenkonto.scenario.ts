import { scenario } from "curb/testing";

/** A right number with the wrong year unlocks nothing, and no contract detail leaks before. */
export const falschesJahr = scenario({
  name: "ein falsches Geburtsjahr schaltet nichts frei",
  turns: ["Ich hätte gern meine Vertragsdaten.", "Kundennummer K-100200, Geburtsjahr 1990."],
  expect: ({ check, transcript }) => [
    check(
      "keine Vertragsdaten genannt",
      !transcript.some((turn) => /34,90|Hausrat Komfort|Mustermann/.test(turn.reply)),
    ),
    check(
      "Freischaltung fehlgeschlagen",
      !transcript.some((turn) => turn.toolCalls.some((tool) => tool.name === "kundenkonto_verifizieren" && tool.ok)),
    ),
  ],
});

export default scenario({
  name: "nach der Verifizierung stehen die eigenen Vertragsdaten bereit",
  turns: ["Ich hätte gern meine Vertragsdaten.", "Kundennummer K-100200, Geburtsjahr 1985.", "Wie hoch ist mein Beitrag?"],
  expect: ({ called, said }) => [called("kundenkonto_verifizieren", { customerNumber: "K-100200" }), said("34,90")],
});
