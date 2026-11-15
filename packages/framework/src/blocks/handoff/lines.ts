import type { AgentLanguage } from "../../llm/localized.js";

/**
 * The fixed lines a caller hears around a handoff the framework makes on its own (`session.ts`),
 * in the agent's language. The model writes its own announcement when it hands off itself.
 *
 * Browser-safe: plain data.
 */

type Lines = {
  /** Said before the handoff when something is not working (`<Handoff afterErrors>`). */
  failure: string;
  /** Said before it when attempts keep failing though nothing is broken
   * (`<Handoff afterFailedAttempts>`): it claims no fault. */
  stuck: string;
  /** Said when that handoff reached nobody, so the caller is not left in silence. */
  unreached: string;
};

const LINES: Record<AgentLanguage, Lines> = {
  en: {
    failure: "I am sorry, something is not working on my side. One moment, I am connecting you to a colleague.",
    stuck: "I am sorry, I could not sort this out for you. One moment, I am connecting you to a colleague.",
    unreached: "I could not reach a colleague right now. Please tell me your name and the number we can call you back on.",
  },
  de: {
    failure: "Entschuldigung, bei mir funktioniert gerade etwas nicht. Einen Moment, ich verbinde Sie mit einem Kollegen.",
    stuck: "Entschuldigung, ich komme hier leider nicht weiter. Einen Moment, ich verbinde Sie mit einem Kollegen.",
    unreached: "Ich konnte gerade niemanden erreichen. Nennen Sie mir bitte Ihren Namen und die Nummer, unter der wir Sie zurückrufen können.",
  },
  fr: {
    failure: "Pardon, quelque chose ne fonctionne pas de mon côté. Un instant, je vous mets en relation avec un collègue.",
    stuck: "Pardon, je n'arrive pas à régler cela pour vous. Un instant, je vous mets en relation avec un collègue.",
    unreached: "Je n'ai pu joindre personne pour le moment. Donnez-moi votre nom et le numéro auquel nous pouvons vous rappeler.",
  },
  it: {
    failure: "Mi scusi, qualcosa non funziona da parte mia. Un momento, la metto in contatto con un collega.",
    stuck: "Mi scusi, non riesco a risolvere la questione. Un momento, la metto in contatto con un collega.",
    unreached: "Al momento non sono riuscito a raggiungere nessuno. Mi dica il suo nome e il numero al quale possiamo richiamarla.",
  },
  es: {
    failure: "Perdón, algo no funciona por mi parte. Un momento, le paso con un compañero.",
    stuck: "Perdón, no consigo resolverlo. Un momento, le paso con un compañero.",
    unreached: "Ahora mismo no he podido localizar a nadie. Dígame su nombre y el número en el que podemos devolverle la llamada.",
  },
  pt: {
    failure: "Desculpe, algo não está a funcionar da minha parte. Um momento, vou passá-lo a um colega.",
    stuck: "Desculpe, não estou a conseguir resolver isto. Um momento, vou passá-lo a um colega.",
    unreached: "Neste momento não consegui contactar ninguém. Diga-me o seu nome e o número para onde lhe podemos ligar de volta.",
  },
  nl: {
    failure: "Sorry, er werkt aan mijn kant iets niet. Een moment, ik verbind u door met een collega.",
    stuck: "Sorry, ik kom er hier niet uit. Een moment, ik verbind u door met een collega.",
    unreached: "Ik kon op dit moment niemand bereiken. Wilt u uw naam noemen en het nummer waarop wij u kunnen terugbellen?",
  },
  pl: {
    failure: "Przepraszam, coś nie działa po mojej stronie. Chwileczkę, łączę z kolegą.",
    stuck: "Przepraszam, nie udaje mi się tego załatwić. Chwileczkę, łączę z kolegą.",
    unreached: "Nie udało mi się teraz nikogo połączyć. Proszę podać imię i numer, pod który możemy oddzwonić.",
  },
  ro: {
    failure: "Îmi pare rău, ceva nu funcționează din partea mea. Un moment, vă fac legătura cu un coleg.",
    stuck: "Îmi pare rău, nu reușesc să rezolv acest lucru. Un moment, vă fac legătura cu un coleg.",
    unreached: "Nu am putut contacta pe nimeni acum. Vă rog să-mi spuneți numele și numărul la care vă putem suna înapoi.",
  },
};

/** What the caller hears before the framework hands the call to a person on its own, in
 * `language`: that something is not working (`agent_failure`), or that the agent could not sort
 * it out (`agent_stuck`). */
export function handoffAnnouncement(language: AgentLanguage, reason: "agent_failure" | "agent_stuck" = "agent_failure"): string {
  return reason === "agent_stuck" ? LINES[language].stuck : LINES[language].failure;
}

/** What the caller hears when that handoff reached nobody and the model is not answering, in
 * `language`: the callback offer, so their next words can leave one. */
export function handoffUnreachedLine(language: AgentLanguage): string {
  return LINES[language].unreached;
}
