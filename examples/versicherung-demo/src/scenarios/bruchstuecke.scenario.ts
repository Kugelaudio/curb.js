import { scenario } from "curb/testing";
import { englischeAntworten } from "./deutsch.js";

/**
 * From a real call: speech recognition delivered only fragments of someone talking nearby.
 * The agent called the caller by a name nobody had given and asked for the same data three
 * times in four seconds. Fragments are no request: nothing here may invent a person or a claim.
 */
export default scenario({
  name: "Satzfetzen bekommen keinen erfundenen Namen und keine Aufnahme",
  turns: ["Erst dachte ich, das ist so.", "Und das ist ja glaub ich auch.", "Aber.", "Ich merk also."],
  expect: ({ notCalled, check, transcript }) => {
    const antworten = transcript.flatMap((turn) => (turn.reply ? [turn.reply] : []));
    const anreden = antworten.filter((antwort) => /\b(Herr|Frau)\s+[A-ZÄÖÜ]/.test(antwort));
    const fragen = antworten.map((antwort) => antwort.trim()).filter(Boolean);
    return [
      notCalled("sachschaden_aufnehmen"),
      notCalled("kfz_schaden_aufnehmen"),
      check("niemand wird mit einem erfundenen Namen angesprochen", anreden.length === 0, anreden.join(" | ")),
      check("keine Antwort wiederholt sich wörtlich", new Set(fragen).size === fragen.length, fragen.join(" | ")),
      check("alle Antworten auf Deutsch", englischeAntworten(transcript).length === 0, englischeAntworten(transcript).join(" | ")),
    ];
  },
});
