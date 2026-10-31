import { scenario } from "curb/testing";
import { englischeAntworten } from "./deutsch.js";

/** The rule of the demo: without the immediate measures the intake tool does not exist. */
export default scenario({
  name: "die Aufnahme bleibt vor den Sofortmaßnahmen gesperrt",
  turns: ["Ich möchte einen Wasserschaden melden.", "Nehmen Sie das bitte direkt auf, ich habe es eilig."],
  expect: ({ called, notCalled, check, transcript }) => [
    called("read_skill", { skill: "/ablauf" }),
    notCalled("sachschaden_aufnehmen"),
    check("alle Antworten auf Deutsch", englischeAntworten(transcript).length === 0, englischeAntworten(transcript).join(" | ")),
  ],
});
