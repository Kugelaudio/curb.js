/**
 * The demo's stand-in for your systems. Every tool that reads or writes customer data goes
 * through this file, so connecting a real policy system means replacing these three
 * functions and nothing else. The data is invented.
 */

export type Kunde = {
  kundennummer: string;
  geburtsjahr: string;
  name: string;
  tarif: string;
  versicherungssumme: string;
  vertragSeit: string;
  selbstbeteiligung: string;
  beitrag: string;
  bausteine: string[];
  offeneVorgaenge: string[];
};

const KUNDEN: Kunde[] = [
  {
    kundennummer: "K-100200",
    geburtsjahr: "1985",
    name: "Erika Mustermann",
    tarif: "Hausrat Komfort",
    versicherungssumme: "85.000 Euro",
    vertragSeit: "1. März 2019",
    selbstbeteiligung: "250 Euro je Schadenfall",
    beitrag: "34,90 Euro monatlich, Abbuchung zum 1. des Monats",
    bausteine: ["Fahrraddiebstahl bis 1.500 Euro", "Elementarschutz"],
    offeneVorgaenge: ["SD-2026-4471, Leitungswasser, in Prüfung"],
  },
  {
    kundennummer: "K-300400",
    geburtsjahr: "1972",
    name: "Max Beispiel",
    tarif: "Wohngebäude Basis",
    versicherungssumme: "320.000 Euro",
    vertragSeit: "15. Januar 2022",
    selbstbeteiligung: "500 Euro je Schadenfall",
    beitrag: "61,20 Euro monatlich, Abbuchung zum 15. des Monats",
    bausteine: [],
    offeneVorgaenge: [],
  },
];

/** The customer with both details right, or null. A wrong detail does not say which one. */
export function kundePruefen(kundennummer: string, geburtsjahr: string): Kunde | null {
  return KUNDEN.find((k) => k.kundennummer === kundennummer && k.geburtsjahr === geburtsjahr) ?? null;
}

/** The customer behind a number that has already been verified. */
export function kundeLesen(kundennummer: string): Kunde | null {
  return KUNDEN.find((k) => k.kundennummer === kundennummer) ?? null;
}

let letzterVorgang = 4471;

/** Files a claim and returns its case number. Here it only counts up. */
export function schadenAnlegen(): string {
  letzterVorgang += 1;
  return `SD-2026-${letzterVorgang}`;
}
