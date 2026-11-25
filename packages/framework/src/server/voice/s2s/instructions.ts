/**
 * The instructions a speech-to-speech model gets on `<Agent s2s>`: the agent's own prompt, then
 * how to work with the back office and everything the back office can do, in the call's
 * language.
 *
 * The model's protocol has no field for the tools of a back office it does not run, so the
 * instructions carry them: every skill with the tools it adds, read before any skill opens
 * (`AgentSiteRuntime.skillCatalog`), so the model knows what to hand over from the first
 * turn. The rules, the list's title and its fixed items are in the agent's language, so a
 * German agent's instructions are German throughout.
 */

import type { AgentLanguage } from "../../../llm/localized.js";
import type { AgentSiteRuntime, CatalogTool } from "../../../runtime.js";

type Wording = {
  /** Said when the call's language is set (`openai.live({ language })`), from its tag. */
  speak: (tag: string) => string;
  /** How the model works with the back office, one line. */
  rules: string[];
  /** The line right above the list. */
  list: string;
  /** A list item: the caller's answers to the back office's questions go back to it. */
  answers: string;
  /** A list item: ending the call. */
  endCall: string;
};

const WORDING: Record<AgentLanguage, Wording> = {
  en: {
    // English is also the wording of a language without one here, so it names the language.
    speak: (tag) => `Speak ${languageName(tag)} with the caller.`,
    rules: [
      "A back office works behind you: it can do the work listed below and run its tools, and you cannot.",
      "Hand over anything that needs one of them, and never say something was done until the back office reports it.",
      "It can do more than this list shows, so hand over whatever you cannot do yourself, and never tell the caller something cannot be done.",
      "When the back office gives you a question or a line to confirm, ask it. Keep every name, number, date and time exactly as written.",
      "You cannot hang up. When the caller is finished or says goodbye, do not say goodbye yourself: hand that over, and the back office ends the call and gives you the goodbye to say.",
    ],
    list: "The back office does this:",
    answers:
      "The caller's answer to a question the back office asked, even a short yes or no, a name, a number or a date: hand it over, the back office is waiting for it.",
    endCall: "Ending the call, when the caller is finished or says goodbye.",
  },
  de: {
    speak: () => "Sprich mit dem Anrufer Deutsch.",
    rules: [
      "Hinter dir arbeitet ein Backoffice: Es kann die unten aufgeführten Aufgaben erledigen und ihre Werkzeuge ausführen, du nicht.",
      "Gib alles ab, was eines davon braucht, und sag nie, dass etwas erledigt ist, bevor das Backoffice es meldet.",
      "Es kann mehr, als diese Liste zeigt: Gib alles ab, was du nicht selbst kannst, und sag dem Anrufer nie, dass etwas nicht geht.",
      "Wenn das Backoffice dir eine Frage oder einen Satz zum Bestätigen gibt, stell sie. Übernimm jeden Namen, jede Zahl, jedes Datum und jede Uhrzeit genau so, wie sie dastehen.",
      "Du kannst nicht auflegen. Wenn der Anrufer fertig ist oder sich verabschiedet, verabschiede dich nicht selbst: Gib das ab, dann beendet das Backoffice den Anruf und gibt dir den Abschiedssatz.",
    ],
    list: "Das Backoffice übernimmt:",
    answers:
      "Die Antwort des Anrufers auf eine Frage des Backoffice, auch ein kurzes Ja oder Nein, ein Name, eine Zahl oder ein Datum: Gib sie ab, das Backoffice wartet darauf.",
    endCall: "Den Anruf beenden, wenn der Anrufer fertig ist oder sich verabschiedet.",
  },
  fr: {
    speak: () => "Parle français avec l'appelant.",
    rules: [
      "Un back-office travaille derrière toi : il peut accomplir les tâches listées ci-dessous et utiliser leurs outils, toi non.",
      "Transmets-lui tout ce qui en a besoin, et ne dis jamais qu'une chose est faite avant que le back-office ne le confirme.",
      "Il peut faire plus que ce que montre cette liste : transmets tout ce que tu ne peux pas faire toi-même, et ne dis jamais à l'appelant qu'une chose est impossible.",
      "Quand le back-office te donne une question ou une phrase à confirmer, pose-la. Garde chaque nom, nombre, date et heure exactement tels qu'ils sont écrits.",
      "Tu ne peux pas raccrocher. Quand l'appelant a terminé ou dit au revoir, ne dis pas au revoir toi-même : transmets-le, le back-office termine l'appel et te donne la phrase d'adieu.",
    ],
    list: "Le back-office s'occupe de ceci :",
    answers:
      "La réponse de l'appelant à une question du back-office, même un simple oui ou non, un nom, un nombre ou une date : transmets-la, le back-office l'attend.",
    endCall: "Terminer l'appel, quand l'appelant a fini ou dit au revoir.",
  },
  it: {
    speak: () => "Parla italiano con chi chiama.",
    rules: [
      "Dietro di te lavora un back office: può svolgere i compiti elencati qui sotto e usare i loro strumenti, tu no.",
      "Passagli tutto ciò che ne ha bisogno e non dire mai che qualcosa è fatto finché il back office non lo conferma.",
      "Può fare più di quanto mostri questo elenco: passagli tutto ciò che non puoi fare da solo e non dire mai a chi chiama che qualcosa non si può fare.",
      "Quando il back office ti dà una domanda o una frase da confermare, falla. Mantieni ogni nome, numero, data e ora esattamente come sono scritti.",
      "Non puoi riagganciare. Quando chi chiama ha finito o saluta, non salutare tu: passalo al back office, che chiude la chiamata e ti dà il saluto da dire.",
    ],
    list: "Il back office si occupa di:",
    answers:
      "La risposta di chi chiama a una domanda del back office, anche un semplice sì o no, un nome, un numero o una data: passala, il back office la sta aspettando.",
    endCall: "Chiudere la chiamata, quando chi chiama ha finito o saluta.",
  },
  es: {
    speak: () => "Habla español con quien llama.",
    rules: [
      "Detrás de ti trabaja un back office: puede hacer las tareas de la lista de abajo y usar sus herramientas, y tú no.",
      "Pásale todo lo que necesite una de ellas, y nunca digas que algo está hecho hasta que el back office lo confirme.",
      "Puede hacer más de lo que muestra esta lista: pásale todo lo que no puedas hacer tú, y nunca digas a quien llama que algo no se puede hacer.",
      "Cuando el back office te dé una pregunta o una frase para confirmar, hazla. Mantén cada nombre, número, fecha y hora tal como están escritos.",
      "No puedes colgar. Cuando quien llama termine o se despida, no te despidas tú: pásalo al back office, que termina la llamada y te da la despedida.",
    ],
    list: "El back office se encarga de:",
    answers:
      "La respuesta de quien llama a una pregunta del back office, incluso un simple sí o no, un nombre, un número o una fecha: pásasela, el back office la está esperando.",
    endCall: "Terminar la llamada, cuando quien llama haya terminado o se despida.",
  },
  pt: {
    speak: () => "Fale português com quem liga.",
    rules: [
      "Um back office trabalha por trás de você: ele pode fazer as tarefas listadas abaixo e usar as ferramentas delas, e você não.",
      "Passe para ele tudo o que precisar de uma delas, e nunca diga que algo foi feito antes que o back office confirme.",
      "Ele pode fazer mais do que esta lista mostra: passe tudo o que você não puder fazer sozinho, e nunca diga a quem liga que algo não pode ser feito.",
      "Quando o back office lhe der uma pergunta ou uma frase para confirmar, faça-a. Mantenha cada nome, número, data e hora exatamente como estão escritos.",
      "Você não pode desligar. Quando quem liga terminar ou se despedir, não se despeça você: passe isso ao back office, que encerra a chamada e lhe dá a despedida.",
    ],
    list: "O back office cuida de:",
    answers:
      "A resposta de quem liga a uma pergunta do back office, mesmo um simples sim ou não, um nome, um número ou uma data: passe-a, o back office está esperando por ela.",
    endCall: "Encerrar a chamada, quando quem liga terminar ou se despedir.",
  },
  nl: {
    speak: () => "Spreek Nederlands met de beller.",
    rules: [
      "Achter je werkt een backoffice: die kan de taken hieronder uitvoeren en hun tools gebruiken, jij niet.",
      "Geef alles door waarvoor een van die taken nodig is, en zeg nooit dat iets gedaan is voordat de backoffice het meldt.",
      "Die kan meer dan deze lijst laat zien: geef alles door wat je zelf niet kunt, en zeg de beller nooit dat iets niet kan.",
      "Als de backoffice je een vraag of een zin om te bevestigen geeft, stel die. Neem elke naam, elk getal, elke datum en elke tijd precies zo over als ze er staan.",
      "Je kunt niet ophangen. Als de beller klaar is of gedag zegt, zeg zelf geen gedag: geef dat door, dan beëindigt de backoffice het gesprek en geeft je de afscheidszin.",
    ],
    list: "De backoffice regelt:",
    answers:
      "Het antwoord van de beller op een vraag van de backoffice, ook een kort ja of nee, een naam, een getal of een datum: geef het door, de backoffice wacht erop.",
    endCall: "Het gesprek beëindigen, als de beller klaar is of gedag zegt.",
  },
  pl: {
    speak: () => "Mów do rozmówcy po polsku.",
    rules: [
      "Za tobą pracuje back office: może wykonać zadania wymienione poniżej i użyć ich narzędzi, a ty nie.",
      "Przekazuj wszystko, co wymaga któregoś z nich, i nigdy nie mów, że coś zostało zrobione, zanim back office to potwierdzi.",
      "Może zrobić więcej, niż pokazuje ta lista: przekazuj wszystko, czego nie możesz zrobić sam, i nigdy nie mów rozmówcy, że czegoś nie da się zrobić.",
      "Gdy back office da ci pytanie lub zdanie do potwierdzenia, zadaj je. Zachowaj każde imię, liczbę, datę i godzinę dokładnie tak, jak są zapisane.",
      "Nie możesz się rozłączyć. Gdy rozmówca skończy lub się żegna, nie żegnaj się sam: przekaż to, a back office zakończy rozmowę i poda ci pożegnanie.",
    ],
    list: "Back office zajmuje się:",
    answers:
      "Odpowiedź rozmówcy na pytanie back office, nawet krótkie tak lub nie, imię, liczba lub data: przekaż ją, back office na nią czeka.",
    endCall: "Zakończenie rozmowy, gdy rozmówca skończył lub się żegna.",
  },
  ro: {
    speak: () => "Vorbește românește cu apelantul.",
    rules: [
      "În spatele tău lucrează un back office: poate face sarcinile de mai jos și poate folosi instrumentele lor, tu nu.",
      "Predă tot ce are nevoie de una dintre ele și nu spune niciodată că ceva s-a făcut până nu confirmă back office-ul.",
      "Poate face mai mult decât arată această listă: predă tot ce nu poți face singur și nu-i spune niciodată apelantului că ceva nu se poate.",
      "Când back office-ul îți dă o întrebare sau o frază de confirmat, pune-o. Păstrează fiecare nume, număr, dată și oră exact cum sunt scrise.",
      "Nu poți închide. Când apelantul a terminat sau își ia la revedere, nu-ți lua tu la revedere: predă asta, iar back office-ul încheie apelul și îți dă formula de rămas-bun.",
    ],
    list: "Back office-ul se ocupă de:",
    answers:
      "Răspunsul apelantului la o întrebare a back office-ului, chiar și un simplu da sau nu, un nume, un număr sau o dată: predă-l, back office-ul îl așteaptă.",
    endCall: "Încheierea apelului, când apelantul a terminat sau își ia la revedere.",
  },
};

/** How much of a description one list item keeps: the list is read on every turn. */
const ITEM_CHARACTERS = 160;

/**
 * The model reads the agent's `<SystemPrompt>`: who it is and how it sounds. Everything else the
 * agent renders (an `<Instruction>`, text, a skill) is the procedure, which `llm` runs behind
 * it; the model only needs to know what to hand over, and learns the rest from commentary.
 */
export function voiceInstructions(runtime: AgentSiteRuntime): string {
  const wording = WORDING[runtime.settings.language()];
  const tag = runtime.settings.s2s()?.options.language;
  const rules = [...(tag === undefined ? [] : [wording.speak(tag)]), ...wording.rules].join(" ");
  return [
    runtime.snapshot().context.systemPrompt ?? "",
    [rules, wording.list, ...backOfficeWork(runtime, wording)].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the model hands over, one list item each: answers and the goodbye first, then the
 * agent's own tools, then every skill with the tools it adds as items under it. */
function backOfficeWork(runtime: AgentSiteRuntime, wording: Wording): string[] {
  const catalog = runtime.skillCatalog();
  return [
    `- ${wording.answers}`,
    `- ${wording.endCall}`,
    ...catalog.tools.map((tool) => `- ${toolItem(tool)}`),
    ...catalog.skills.flatMap((skill) => [
      `- ${skillItem(skill.label, skill.description)}`,
      ...skill.tools.map((tool) => `  - ${toolItem(tool)}`),
    ]),
  ];
}

function toolItem(tool: CatalogTool): string {
  const description = short(tool.description);
  return description ? `${tool.name}: ${description}` : tool.name;
}

/** "Label: description", or the description alone when it already starts with the label. */
function skillItem(label: string, description: string | undefined): string {
  if (!description) return label;
  const text = short(description);
  return text.toLowerCase().startsWith(label.toLowerCase()) ? text : `${label}: ${text}`;
}

/** "German" for "de-DE", in English; the tag itself when `Intl` has no name for it. */
function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" }).of(tag.split(/[-_]/)[0]!) ?? tag;
  } catch {
    // KEEP-JUSTIFIED: a tag `Intl` rejects is still the author's word for the language.
    return tag;
  }
}

/** `text` on one line, cut at a word to at most {@link ITEM_CHARACTERS} characters. */
function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= ITEM_CHARACTERS) return line;
  const cut = line.slice(0, ITEM_CHARACTERS - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > ITEM_CHARACTERS / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}
