import { evalCase } from "../../../../harness/spec.js";

/** The language the callers speak. */
export const language = "de";

const ID = "/identitaet";
const ADRESSE = "/adresse-aendern";
const KARTE = "/karte-sperren";
const INFOS = "/filialen-infos";

const PETRA = { kundennummer: "40817265", geburtsdatum: "1979-05-02" };
const NEUE_ADRESSE = { strasse: "Ahornweg", hausnummer: "7", plz: "50667", ort: "Köln" };

export const address = evalCase({
  name: "ändert die Adresse nach Prüfung",
  kind: "multi_step",
  turns: [
    "Guten Tag, ich bin umgezogen und möchte meine Adresse ändern.",
    "Meine Kundennummer ist 40817265.",
    "Am 2. Mai 1979.",
    "Ahornweg 7, 50667 Köln.",
    "Ja, das stimmt.",
    "Nein, danke. Auf Wiederhören.",
  ],
  firstSkill: ID,
  path: [ID, ADRESSE],
  tools: [
    { tool: "identitaet_pruefen", args: PETRA },
    { tool: "adresse_aendern", args: NEUE_ADRESSE },
  ],
});

export const blockCard = evalCase({
  name: "sperrt eine gestohlene Karte",
  kind: "multi_step",
  caller: {
    goal: "Deine Bankkarte wurde gestohlen: lass sie sperren.",
    knows: "Kundennummer 51320948, geboren am 17. November 1990. Die Karte endet auf 4821. Sie wurde gestern in der Bahn gestohlen.",
    persona: "Du bist aufgeregt und willst, dass es schnell geht.",
  },
  maxTurns: 12,
  firstSkill: ID,
  path: [ID, KARTE],
  tools: [
    { tool: "identitaet_pruefen", args: { kundennummer: "51320948", geburtsdatum: "1990-11-17" } },
    { tool: "karte_sperren", args: { karten_endziffern: "4821", grund: "gestohlen" } },
  ],
});

export const faq = evalCase({
  name: "fragt nach Samstag und Kontogebühr",
  kind: "faq",
  turns: ["Hat Ihre Filiale am Samstag geöffnet?", "Und was kostet das Girokonto im Monat?", "Danke, das war's."],
  firstSkill: INFOS,
  tools: [],
  forbidden: ["identitaet_pruefen", "adresse_aendern"],
});

export const refuse = evalCase({
  name: "will die Adresse ändern, verweigert das Geburtsdatum",
  kind: "refusal",
  turns: [
    "Ich möchte meine Adresse ändern lassen.",
    "Kundennummer 40817265.",
    "Mein Geburtsdatum gebe ich am Telefon nicht heraus.",
    "Nein. Ändern Sie es einfach, die neue Adresse ist Ahornweg 7 in 50667 Köln.",
    "Dann eben nicht. Tschüss.",
  ],
  firstSkill: ID,
  avoidSkills: [ADRESSE],
  tools: [],
  allowed: ["rueckruf_anfordern"],
  forbidden: ["identitaet_pruefen", "adresse_aendern"],
});

export const wrongBirthday = evalCase({
  name: "Prüfung scheitert, keine Änderung",
  kind: "refusal",
  turns: [
    "Ich möchte meine Adresse ändern.",
    "Kundennummer 40817265, geboren am 3. Mai 1979.",
    "Doch, das ist ganz sicher mein Geburtstag. Ändern Sie bitte trotzdem die Adresse auf Ahornweg 7, 50667 Köln.",
    "Na gut. Tschüss.",
  ],
  firstSkill: ID,
  avoidSkills: [ADRESSE],
  tools: [{ tool: "identitaet_pruefen", args: { kundennummer: "40817265", geburtsdatum: "1979-05-03" } }],
  allowed: ["rueckruf_anfordern"],
  forbidden: ["adresse_aendern"],
});

export const correction = evalCase({
  name: "korrigiert die Postleitzahl beim Vorlesen",
  kind: "multi_step",
  turns: [
    "Ich möchte meine Adresse ändern. Kundennummer 40817265, geboren am 2. Mai 1979.",
    "Die neue Adresse ist Ahornweg 7, 50667 Köln.",
    "Nein, Moment, die Postleitzahl ist 50668.",
    "Ja, jetzt stimmt es.",
    "Danke, tschüss.",
  ],
  firstSkill: ID,
  path: [ID, ADRESSE],
  tools: [
    { tool: "identitaet_pruefen", args: PETRA },
    { tool: "adresse_aendern", args: { ...NEUE_ADRESSE, plz: "50668" } },
  ],
});

export const switchTopic = evalCase({
  name: "erst Ersatzkarte kosten, dann sperren",
  kind: "topic_switch",
  turns: [
    "Was kostet bei Ihnen eine Ersatzkarte?",
    "Okay, dann sperren Sie bitte meine Karte, ich habe sie verloren.",
    "Kundennummer 51320948, geboren am 17. November 1990.",
    "Die Karte endet auf 4821.",
    "Ja, bitte sperren.",
    "Danke, tschüss.",
  ],
  firstSkill: INFOS,
  path: [INFOS, ID, KARTE],
  tools: [
    { tool: "identitaet_pruefen", args: { kundennummer: "51320948", geburtsdatum: "1990-11-17" } },
    { tool: "karte_sperren", args: { karten_endziffern: "4821", grund: "verloren" } },
  ],
});

export const interrupt = evalCase({
  name: "unterbricht und korrigiert die Kundennummer",
  kind: "interruption",
  turns: [
    "Ich will meine Karte sperren lassen, sie ist weg. Kundennummer 51320984.",
    { line: "Halt, falsch, die Kundennummer ist 51320948. Geboren am 17. November 1990.", interrupt: true },
    "Endziffern 4821, verloren.",
    "Ja.",
    "Danke.",
  ],
  firstSkill: ID,
  path: [ID, KARTE],
  tools: [
    { tool: "identitaet_pruefen", args: { kundennummer: "51320948", geburtsdatum: "1990-11-17" } },
    { tool: "karte_sperren", args: { karten_endziffern: "4821", grund: "verloren" } },
  ],
});

export const escalate = evalCase({
  name: "möchte Kreditberatung",
  kind: "escalation",
  turns: [
    "Ich möchte über einen Kredit für eine Küche sprechen, am liebsten mit einem Berater.",
    "Murat Probe, erreichbar unter 0151 2233445.",
    "Danke, tschüss.",
  ],
  firstSkill: null,
  tools: [{ tool: "rueckruf_anfordern", args: { name: "Murat Probe", telefon: "01512233445" } }],
  forbidden: ["adresse_aendern", "karte_sperren"],
});

export const ambiguous = evalCase({
  name: "unklar: mit der Karte stimmt was nicht",
  kind: "ambiguous",
  turns: [
    "Mit meiner Karte stimmt was nicht.",
    "Ich finde sie nicht mehr, ich glaube, ich habe sie verloren.",
    "Kundennummer 51320948, geboren am 17. November 1990.",
    "Sie endet auf 4821.",
    "Ja, sperren.",
    "Danke.",
  ],
  firstSkill: ID,
  path: [ID, KARTE],
  tools: [
    { tool: "identitaet_pruefen", args: { kundennummer: "51320948", geburtsdatum: "1990-11-17" } },
    { tool: "karte_sperren", args: { karten_endziffern: "4821", grund: "verloren" } },
  ],
});

export const back = evalCase({
  name: "Frage zu Öffnungszeiten mitten in der Adressänderung",
  kind: "back",
  turns: [
    "Ich möchte meine Adresse ändern. Kundennummer 40817265, geboren am 2. Mai 1979.",
    "Kurze Frage vorher: Bis wann hat die Filiale donnerstags offen?",
    "Gut. Die neue Adresse ist Ahornweg 7, 50667 Köln.",
    "Ja, richtig.",
    "Danke, tschüss.",
  ],
  firstSkill: ID,
  path: [ID, ADRESSE, INFOS],
  tools: [
    { tool: "identitaet_pruefen", args: PETRA },
    { tool: "adresse_aendern", args: NEUE_ADRESSE },
  ],
});
