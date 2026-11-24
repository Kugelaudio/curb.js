import { Instruction, Text, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Termin buchen",
  description: "Einen neuen Termin vereinbaren: freie Termine suchen und buchen.",
};

const ARTEN = ["kontrolle", "akut", "impfung"] as const;

/** Fake calendar: every weekday in December 2026 has the same three free times. */
const FREIE_ZEITEN = ["08:30", "11:00", "15:30"];

export default function TerminBuchen() {
  return (
    <>
      <Instruction>{`
        Frag nach dem Grund des Termins (Kontrolle, akut oder Impfung) und dem Wunschtag.
        Such dann mit freie_termine_suchen und biete die freien Uhrzeiten an.
        Wenn der Anrufer eine Uhrzeit gewählt hat, frag nach Vor- und Nachnamen und Geburtsdatum
        und buche mit termin_buchen. Nenn danach die Buchungsnummer.
      `}</Instruction>
      <Text>Die Praxis vergibt Termine von Montag bis Freitag.</Text>
      <Tool
        name="freie_termine_suchen"
        description="Freie Termine an einem Tag suchen."
        schema={z.object({
          datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT.").describe("Der Wunschtag, JJJJ-MM-TT."),
          art: z.enum(ARTEN).describe("Grund des Termins."),
        })}
        onSubmit={(input) => {
          const day = new Date(`${input.datum}T12:00:00Z`).getUTCDay();
          if (day === 0 || day === 6) return { ok: true, message: `Am ${input.datum} ist die Praxis geschlossen. Biete einen Werktag an.` };
          return { ok: true, message: `Frei am ${input.datum}: ${FREIE_ZEITEN.join(", ")} Uhr.` };
        }}
      />
      <Tool
        name="termin_buchen"
        description="Einen freien Termin für den Anrufer buchen."
        schema={z.object({
          datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT.").describe("Tag, JJJJ-MM-TT."),
          uhrzeit: z.string().regex(/^\d{2}:\d{2}$/, "Uhrzeit als HH:MM.").describe("Uhrzeit, HH:MM."),
          art: z.enum(ARTEN).describe("Grund des Termins."),
          name: z.string().min(3).describe("Vor- und Nachname des Patienten."),
          geburtsdatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Geburtsdatum als JJJJ-MM-TT.").describe("Geburtsdatum, JJJJ-MM-TT."),
        })}
        onSubmit={(input) => {
          if (!FREIE_ZEITEN.includes(input.uhrzeit)) return { ok: false, message: `${input.uhrzeit} ist nicht frei. Frei sind ${FREIE_ZEITEN.join(", ")}.` };
          return { ok: true, message: `Gebucht: ${input.datum} um ${input.uhrzeit} Uhr für ${input.name}. Buchungsnummer 482913.` };
        }}
      />
    </>
  );
}
