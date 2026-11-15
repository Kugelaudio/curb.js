/**
 * Text the framework itself produces, in the agent's language: the fixed lines a caller
 * hears when a turn cannot answer, and the date line every LLM request carries.
 *
 * Browser-safe: plain data and `Intl` only.
 */

/** The languages the framework has its own wording for (Kugel Ear's languages). */
export const AGENT_LANGUAGES = ["de", "en", "fr", "it", "es", "pt", "nl", "pl", "ro"] as const;

export type AgentLanguage = (typeof AGENT_LANGUAGES)[number];

/** The time zone an agent tells time in when `defineAgent({ timeZone })` is not set. */
export const DEFAULT_TIME_ZONE = "UTC";

/** How many days after today the date line lists, so "next Tuesday" needs no arithmetic. */
const LISTED_DAYS = 14;

type Wording = {
  /** The turn failed (provider error, timeout, no reply). */
  turnFailed: string;
  /** The turn used all its LLM steps with tool calls still pending. */
  stepLimit: string;
  /** Said before the framework hands the call to a person on its own because something is not
   * working (`<Handoff afterErrors>`). */
  handoff: string;
  /** Said before it does so because attempts keep failing though nothing is broken
   * (`<Handoff afterFailedAttempts>`): it claims no fault. */
  handoffStuck: string;
  /** Said when that handoff reached nobody, so the caller is not left in silence. */
  handoffUnreached: string;
  /** The date line, from the formatted parts. */
  dateLine: (today: string, time: string, timeZone: string, nextDays: string) => string;
};

const WORDING: Record<AgentLanguage, Wording> = {
  en: {
    turnFailed: "Sorry, something went wrong on my side. Could you say that again?",
    stepLimit: "I had to pause before finishing that. If you want me to continue, just say so.",
    handoff: "I am sorry, something is not working on my side. One moment, I am connecting you to a colleague.",
    handoffStuck: "I am sorry, I could not sort this out for you. One moment, I am connecting you to a colleague.",
    handoffUnreached: "I could not reach a colleague right now. Please tell me your name and the number we can call you back on.",
    dateLine: (today, time, zone, days) => `Today is ${today}, ${time} (${zone}). The next days: ${days}`,
  },
  de: {
    turnFailed: "Entschuldigung, bei mir ist etwas schiefgelaufen. Können Sie das bitte noch einmal sagen?",
    stepLimit: "Ich musste kurz unterbrechen, bevor ich fertig war. Wenn ich weitermachen soll, sagen Sie es einfach.",
    handoff: "Entschuldigung, bei mir funktioniert gerade etwas nicht. Einen Moment, ich verbinde Sie mit einem Kollegen.",
    handoffStuck: "Entschuldigung, ich komme hier leider nicht weiter. Einen Moment, ich verbinde Sie mit einem Kollegen.",
    handoffUnreached: "Ich konnte gerade niemanden erreichen. Nennen Sie mir bitte Ihren Namen und die Nummer, unter der wir Sie zurückrufen können.",
    dateLine: (today, time, zone, days) => `Heute ist ${today}, ${time} Uhr (${zone}). Die nächsten Tage: ${days}`,
  },
  fr: {
    turnFailed: "Pardon, un problème est survenu de mon côté. Pouvez-vous répéter, s'il vous plaît ?",
    stepLimit: "J'ai dû faire une pause avant de terminer. Si je dois continuer, dites-le-moi simplement.",
    handoff: "Pardon, quelque chose ne fonctionne pas de mon côté. Un instant, je vous mets en relation avec un collègue.",
    handoffStuck: "Pardon, je n'arrive pas à régler cela pour vous. Un instant, je vous mets en relation avec un collègue.",
    handoffUnreached: "Je n'ai pu joindre personne pour le moment. Donnez-moi votre nom et le numéro auquel nous pouvons vous rappeler.",
    dateLine: (today, time, zone, days) =>
      `Nous sommes le ${today}, il est ${time} (${zone}). Les prochains jours : ${days}`,
  },
  it: {
    turnFailed: "Mi scusi, qualcosa non ha funzionato da parte mia. Può ripetere, per favore?",
    stepLimit: "Ho dovuto fare una pausa prima di finire. Se devo continuare, me lo dica pure.",
    handoff: "Mi scusi, qualcosa non funziona da parte mia. Un momento, la metto in contatto con un collega.",
    handoffStuck: "Mi scusi, non riesco a risolvere la questione. Un momento, la metto in contatto con un collega.",
    handoffUnreached: "Al momento non sono riuscito a raggiungere nessuno. Mi dica il suo nome e il numero al quale possiamo richiamarla.",
    dateLine: (today, time, zone, days) => `Oggi è ${today}, ore ${time} (${zone}). I prossimi giorni: ${days}`,
  },
  es: {
    turnFailed: "Perdón, algo ha fallado por mi parte. ¿Podría repetirlo, por favor?",
    stepLimit: "Tuve que hacer una pausa antes de terminar. Si quiere que continúe, solo dígamelo.",
    handoff: "Perdón, algo no funciona por mi parte. Un momento, le paso con un compañero.",
    handoffStuck: "Perdón, no consigo resolverlo. Un momento, le paso con un compañero.",
    handoffUnreached: "Ahora mismo no he podido localizar a nadie. Dígame su nombre y el número en el que podemos devolverle la llamada.",
    dateLine: (today, time, zone, days) => `Hoy es ${today}, ${time} (${zone}). Los próximos días: ${days}`,
  },
  pt: {
    turnFailed: "Desculpe, ocorreu um erro da minha parte. Pode repetir, por favor?",
    stepLimit: "Precisei fazer uma pausa antes de terminar. Se quiser que eu continue, é só dizer.",
    handoff: "Desculpe, algo não está a funcionar da minha parte. Um momento, vou passá-lo a um colega.",
    handoffStuck: "Desculpe, não estou a conseguir resolver isto. Um momento, vou passá-lo a um colega.",
    handoffUnreached: "Neste momento não consegui contactar ninguém. Diga-me o seu nome e o número para onde lhe podemos ligar de volta.",
    dateLine: (today, time, zone, days) => `Hoje é ${today}, ${time} (${zone}). Os próximos dias: ${days}`,
  },
  nl: {
    turnFailed: "Sorry, er ging aan mijn kant iets mis. Kunt u dat nog eens zeggen?",
    stepLimit: "Ik moest even stoppen voordat ik klaar was. Als ik verder moet gaan, zeg het gerust.",
    handoff: "Sorry, er werkt aan mijn kant iets niet. Een moment, ik verbind u door met een collega.",
    handoffStuck: "Sorry, ik kom er hier niet uit. Een moment, ik verbind u door met een collega.",
    handoffUnreached: "Ik kon op dit moment niemand bereiken. Wilt u uw naam noemen en het nummer waarop wij u kunnen terugbellen?",
    dateLine: (today, time, zone, days) =>
      `Vandaag is het ${today}, ${time} uur (${zone}). De komende dagen: ${days}`,
  },
  pl: {
    turnFailed: "Przepraszam, coś poszło nie tak po mojej stronie. Czy mogę prosić o powtórzenie?",
    stepLimit: "Muszę tu przerwać, zanim skończę. Jeśli mam kontynuować, proszę po prostu powiedzieć.",
    handoff: "Przepraszam, coś nie działa po mojej stronie. Chwileczkę, łączę z kolegą.",
    handoffStuck: "Przepraszam, nie udaje mi się tego załatwić. Chwileczkę, łączę z kolegą.",
    handoffUnreached: "Nie udało mi się teraz nikogo połączyć. Proszę podać imię i numer, pod który możemy oddzwonić.",
    dateLine: (today, time, zone, days) => `Dziś jest ${today}, godz. ${time} (${zone}). Najbliższe dni: ${days}`,
  },
  ro: {
    turnFailed: "Îmi pare rău, ceva nu a funcționat din partea mea. Puteți repeta, vă rog?",
    stepLimit: "A trebuit să fac o pauză înainte să termin. Dacă vreți să continui, spuneți-mi.",
    handoff: "Îmi pare rău, ceva nu funcționează din partea mea. Un moment, vă fac legătura cu un coleg.",
    handoffStuck: "Îmi pare rău, nu reușesc să rezolv acest lucru. Un moment, vă fac legătura cu un coleg.",
    handoffUnreached: "Nu am putut contacta pe nimeni acum. Vă rog să-mi spuneți numele și numărul la care vă putem suna înapoi.",
    dateLine: (today, time, zone, days) => `Astăzi este ${today}, ora ${time} (${zone}). Următoarele zile: ${days}`,
  },
};

/**
 * The language the agent speaks: the TTS language, else the first STT language, else
 * English. Read from the effective settings, so a skill with its own voice changes it. A
 * language without wording here gets English.
 */
export function agentLanguage(settings: {
  tts: { language?: string };
  stt: { language?: string };
}): AgentLanguage {
  const configured = settings.tts.language ?? settings.stt.language ?? "";
  // "de,fr" lists several STT languages, the first expected; "de-DE" names a region.
  const primary = configured.split(",")[0]!.trim().toLowerCase().split(/[-_]/)[0]!;
  return (AGENT_LANGUAGES as readonly string[]).includes(primary) ? (primary as AgentLanguage) : "en";
}

/** The fixed lines a caller hears when a turn cannot answer, in `language`. */
export function fallbackReplies(language: AgentLanguage): { turnFailed: string; stepLimit: string } {
  const { turnFailed, stepLimit } = WORDING[language];
  return { turnFailed, stepLimit };
}

/** What the caller hears before the framework hands the call to a person on its own, in
 * `language`: that something is not working (`agent_failure`), or that the agent could not sort
 * it out (`agent_stuck`). */
export function handoffAnnouncement(language: AgentLanguage, reason: "agent_failure" | "agent_stuck" = "agent_failure"): string {
  return reason === "agent_stuck" ? WORDING[language].handoffStuck : WORDING[language].handoff;
}

/** What the caller hears when that handoff reached nobody and the model is not answering, in
 * `language`: the callback offer, so their next words can leave one. */
export function handoffUnreachedLine(language: AgentLanguage): string {
  return WORDING[language].handoffUnreached;
}

/** Whether `name` is a time zone `Intl` knows (an IANA name such as "Europe/Berlin"). */
export function isTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    // KEEP-JUSTIFIED: a RangeError IS the answer "not a time zone"; callers raise their own error.
    return false;
  }
}

/**
 * Today's date and time in `timeZone`, then the next {@link LISTED_DAYS} days as weekday
 * plus date, in `language`. One line, built per LLM request:
 *
 *   Heute ist Freitag, 23. Oktober 2026, 17:51 Uhr (Europe/Berlin). Die nächsten Tage: Sa 24. Okt., …
 */
export function dateLine(now: Date, timeZone: string, language: AgentLanguage): string {
  const today = new Intl.DateTimeFormat(language, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  const time = new Intl.DateTimeFormat(language, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);

  // Count calendar days in the agent's zone, never 24-hour steps: a DST change would skip
  // or repeat a day. Noon UTC of each date names that date in every zone formatted as UTC.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => Number(parts.find((entry) => entry.type === type)!.value);
  const [year, month, day] = [part("year"), part("month"), part("day")];
  const weekday = new Intl.DateTimeFormat(language, { timeZone: "UTC", weekday: "short" });
  const date = new Intl.DateTimeFormat(language, { timeZone: "UTC", day: "numeric", month: "short" });
  const nextDays: string[] = [];
  for (let offset = 1; offset <= LISTED_DAYS; offset += 1) {
    const next = new Date(Date.UTC(year, month - 1, day + offset, 12));
    nextDays.push(`${weekday.format(next)} ${date.format(next)}`);
  }
  return WORDING[language].dateLine(today, time, timeZone, nextDays.join(", "));
}
