import { evalCase } from "../../../../harness/spec.js";

/** The language the callers speak. */
export const language = "de";

const BUCHEN = "/termin-buchen";
const ABSAGEN = "/termin-absagen";
const INFOS = "/praxis-infos";

const JANA = { name: "Jana Muster", geburtsdatum: "1984-03-12" };

export const bookDirect = evalCase({
  name: "bucht eine Kontrolle",
  kind: "direct",
  caller: {
    goal: "Einen Kontrolltermin am Donnerstag, dem 3. Dezember, um 11 Uhr buchen.",
    knows: "Name Jana Muster, geboren am 12. März 1984.",
  },
  firstSkill: BUCHEN,
  tools: [
    { tool: "freie_termine_suchen", args: { datum: "2026-12-03", art: "kontrolle" } },
    { tool: "termin_buchen", args: { datum: "2026-12-03", uhrzeit: "11:00", ...JANA } },
  ],
});

export const bookScripted = evalCase({
  name: "bucht eine Impfung, alles nacheinander",
  kind: "multi_step",
  turns: [
    "Guten Tag, ich brauche einen Impftermin am Dienstag, dem 8. Dezember.",
    "Um halb neun bitte.",
    "Tobias Probe, geboren am 30. Juli 1991.",
    "Nein, danke. Tschüss.",
  ],
  firstSkill: BUCHEN,
  tools: [
    { tool: "freie_termine_suchen", args: { datum: "2026-12-08", art: "impfung" } },
    { tool: "termin_buchen", args: { datum: "2026-12-08", uhrzeit: "08:30", name: "Tobias Probe", geburtsdatum: "1991-07-30" } },
  ],
});

export const cancel = evalCase({
  name: "sagt einen Termin ab",
  kind: "direct",
  turns: ["Hallo, ich muss leider meinen Termin absagen.", "Jana Muster, geboren am 12. März 1984.", "Ja, bitte absagen.", "Danke, tschüss."],
  firstSkill: ABSAGEN,
  tools: [
    { tool: "termin_finden", args: JANA },
    { tool: "termin_absagen", args: { buchungsnummer: "731045" } },
  ],
  forbidden: ["termin_buchen"],
});

export const faq = evalCase({
  name: "fragt nach Öffnungszeiten und Parken",
  kind: "faq",
  turns: ["Bis wann haben Sie am Mittwoch geöffnet?", "Und kann man bei Ihnen parken?", "Prima, danke, das war's schon."],
  firstSkill: INFOS,
  tools: [],
  forbidden: ["termin_buchen", "rueckruf_anfordern"],
});

export const ambiguous = evalCase({
  name: "unklar: wegen meines Termins",
  kind: "ambiguous",
  turns: [
    "Ja hallo, ich rufe wegen meines Termins an.",
    "Ich kann am Donnerstag doch nicht, ich möchte ihn absagen.",
    "Jana Muster, zwölfter März 1984.",
    "Ja, genau den, bitte absagen.",
    "Danke, auf Wiederhören.",
  ],
  firstSkill: ABSAGEN,
  avoidSkills: [BUCHEN],
  tools: [
    { tool: "termin_finden", args: JANA },
    { tool: "termin_absagen", args: { buchungsnummer: "731045" } },
  ],
  forbidden: ["termin_buchen"],
});

export const switchTopic = evalCase({
  name: "erst Öffnungszeiten, dann Termin",
  kind: "topic_switch",
  turns: [
    "Haben Sie am Donnerstagnachmittag geöffnet?",
    "Gut, dann hätte ich gern einen Kontrolltermin am Donnerstag, dem 3. Dezember, um halb vier.",
    "Jana Muster, geboren am 12. März 1984.",
    "Danke, tschüss.",
  ],
  firstSkill: INFOS,
  path: [INFOS, BUCHEN],
  tools: [{ tool: "termin_buchen", args: { datum: "2026-12-03", uhrzeit: "15:30", ...JANA } }],
  allowed: ["freie_termine_suchen"],
});

export const back = evalCase({
  name: "Frage mitten in der Buchung, dann zurück",
  kind: "back",
  turns: [
    "Ich möchte einen Kontrolltermin am Freitag, dem 4. Dezember.",
    "Ach, eine Frage vorher: Nehmen Sie auch Privatversicherte?",
    "Gut. Dann bitte um elf Uhr am Freitag.",
    "Tobias Probe, geboren am 30. Juli 1991.",
    "Danke, tschüss.",
  ],
  firstSkill: BUCHEN,
  path: [BUCHEN, INFOS],
  tools: [
    { tool: "freie_termine_suchen", args: { datum: "2026-12-04" } },
    { tool: "termin_buchen", args: { datum: "2026-12-04", uhrzeit: "11:00", name: "Tobias Probe", geburtsdatum: "1991-07-30" } },
  ],
});

export const interrupt = evalCase({
  name: "unterbricht und ändert den Tag",
  kind: "interruption",
  turns: [
    "Ich möchte einen Kontrolltermin am Donnerstag, dem 3. Dezember.",
    { line: "Moment, nicht Donnerstag, lieber am Freitag, dem 4. Dezember.", interrupt: true },
    "Um halb neun.",
    "Jana Muster, geboren am 12. März 1984.",
    "Danke, tschüss.",
  ],
  firstSkill: BUCHEN,
  tools: [
    { tool: "freie_termine_suchen", args: { datum: "2026-12-04" } },
    { tool: "termin_buchen", args: { datum: "2026-12-04", uhrzeit: "08:30", ...JANA } },
  ],
});

export const refuse = evalCase({
  name: "verweigert das Geburtsdatum",
  kind: "refusal",
  turns: [
    "Ich brauche einen Akuttermin am Montag, dem 7. Dezember, um elf Uhr.",
    "Jana Muster. Mein Geburtsdatum sage ich am Telefon nicht.",
    "Nein, das möchte ich nicht sagen.",
    "Dann lasse ich es lieber. Tschüss.",
  ],
  firstSkill: BUCHEN,
  tools: [],
  allowed: ["freie_termine_suchen", "rueckruf_anfordern"],
  forbidden: ["termin_buchen"],
});

export const escalate = evalCase({
  name: "will einen Menschen sprechen",
  kind: "escalation",
  turns: [
    "Ich möchte bitte persönlich mit jemandem aus dem Team sprechen, es geht um meinen Befund.",
    "Jana Muster, meine Nummer ist 0170 1234567.",
    "Danke, auf Wiederhören.",
  ],
  firstSkill: null,
  tools: [{ tool: "rueckruf_anfordern", args: { name: "Jana Muster", telefon: "01701234567" } }],
  forbidden: ["termin_buchen", "termin_absagen"],
});

export const prescription = evalCase({
  name: "fragt eilig nach Folgerezept",
  kind: "faq",
  caller: {
    goal: "Herausfinden, bis wann man ein Folgerezept bestellen muss und ab wann man es abholen kann.",
    knows: "Name Tobias Probe.",
    persona: "Du hast es eilig und sprichst knapp.",
  },
  firstSkill: INFOS,
  tools: [],
  allowed: ["rueckruf_anfordern"],
  forbidden: ["termin_buchen"],
});
