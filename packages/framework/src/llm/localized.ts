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
  /** The date line, from the formatted parts. */
  dateLine: (today: string, time: string, timeZone: string, nextDays: string) => string;
};

const WORDING: Record<AgentLanguage, Wording> = {
  en: {
    turnFailed: "Sorry, something went wrong on my side. Could you say that again?",
    stepLimit: "I had to pause before finishing that. If you want me to continue, just say so.",
    dateLine: (today, time, zone, days) => `Today is ${today}, ${time} (${zone}). The next days: ${days}`,
  },
  de: {
    turnFailed: "Entschuldigung, bei mir ist etwas schiefgelaufen. Können Sie das bitte noch einmal sagen?",
    stepLimit: "Ich musste kurz unterbrechen, bevor ich fertig war. Wenn ich weitermachen soll, sagen Sie es einfach.",
    dateLine: (today, time, zone, days) => `Heute ist ${today}, ${time} Uhr (${zone}). Die nächsten Tage: ${days}`,
  },
  fr: {
    turnFailed: "Pardon, un problème est survenu de mon côté. Pouvez-vous répéter, s'il vous plaît ?",
    stepLimit: "J'ai dû faire une pause avant de terminer. Si je dois continuer, dites-le-moi simplement.",
    dateLine: (today, time, zone, days) =>
      `Nous sommes le ${today}, il est ${time} (${zone}). Les prochains jours : ${days}`,
  },
  it: {
    turnFailed: "Mi scusi, qualcosa non ha funzionato da parte mia. Può ripetere, per favore?",
    stepLimit: "Ho dovuto fare una pausa prima di finire. Se devo continuare, me lo dica pure.",
    dateLine: (today, time, zone, days) => `Oggi è ${today}, ore ${time} (${zone}). I prossimi giorni: ${days}`,
  },
  es: {
    turnFailed: "Perdón, algo ha fallado por mi parte. ¿Podría repetirlo, por favor?",
    stepLimit: "Tuve que hacer una pausa antes de terminar. Si quiere que continúe, solo dígamelo.",
    dateLine: (today, time, zone, days) => `Hoy es ${today}, ${time} (${zone}). Los próximos días: ${days}`,
  },
  pt: {
    turnFailed: "Desculpe, ocorreu um erro da minha parte. Pode repetir, por favor?",
    stepLimit: "Precisei fazer uma pausa antes de terminar. Se quiser que eu continue, é só dizer.",
    dateLine: (today, time, zone, days) => `Hoje é ${today}, ${time} (${zone}). Os próximos dias: ${days}`,
  },
  nl: {
    turnFailed: "Sorry, er ging aan mijn kant iets mis. Kunt u dat nog eens zeggen?",
    stepLimit: "Ik moest even stoppen voordat ik klaar was. Als ik verder moet gaan, zeg het gerust.",
    dateLine: (today, time, zone, days) =>
      `Vandaag is het ${today}, ${time} uur (${zone}). De komende dagen: ${days}`,
  },
  pl: {
    turnFailed: "Przepraszam, coś poszło nie tak po mojej stronie. Czy mogę prosić o powtórzenie?",
    stepLimit: "Muszę tu przerwać, zanim skończę. Jeśli mam kontynuować, proszę po prostu powiedzieć.",
    dateLine: (today, time, zone, days) => `Dziś jest ${today}, godz. ${time} (${zone}). Najbliższe dni: ${days}`,
  },
  ro: {
    turnFailed: "Îmi pare rău, ceva nu a funcționat din partea mea. Puteți repeta, vă rog?",
    stepLimit: "A trebuit să fac o pauză înainte să termin. Dacă vreți să continui, spuneți-mi.",
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
