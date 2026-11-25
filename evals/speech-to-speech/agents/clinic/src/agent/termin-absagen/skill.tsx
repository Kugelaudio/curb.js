import { Instruction, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Termin absagen",
  description: "Einen bestehenden Termin finden und absagen.",
};

/** Fake bookings, by patient. */
const TERMINE: Record<string, { buchungsnummer: string; wann: string }> = {
  "jana muster|1984-03-12": { buchungsnummer: "731045", wann: "Donnerstag, 3. Dezember 2026, 11:00 Uhr" },
  "tobias probe|1991-07-30": { buchungsnummer: "550218", wann: "Dienstag, 8. Dezember 2026, 08:30 Uhr" },
};

export default function TerminAbsagen() {
  return (
    <>
      <Instruction>{`
        Frag nach Vor- und Nachnamen und Geburtsdatum und such den Termin mit termin_finden.
        Lies den gefundenen Termin vor und sag ihn erst ab, wenn der Anrufer bestätigt, dass er abgesagt werden soll.
      `}</Instruction>
      <Tool
        name="termin_finden"
        description="Den nächsten Termin eines Patienten finden."
        schema={z.object({
          name: z.string().min(3).describe("Vor- und Nachname."),
          geburtsdatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Geburtsdatum als JJJJ-MM-TT.").describe("Geburtsdatum, JJJJ-MM-TT."),
        })}
        onSubmit={(input) => {
          const found = TERMINE[`${input.name.trim().toLowerCase()}|${input.geburtsdatum}`];
          return found
            ? { ok: true, message: `Termin: ${found.wann}, Buchungsnummer ${found.buchungsnummer}.` }
            : { ok: true, message: "Kein Termin unter diesem Namen und Geburtsdatum gefunden." };
        }}
      />
      <Tool
        name="termin_absagen"
        description="Einen gefundenen Termin absagen."
        schema={z.object({ buchungsnummer: z.string().regex(/^\d{6}$/, "Die Buchungsnummer hat sechs Ziffern.").describe("Buchungsnummer, sechs Ziffern.") })}
        onSubmit={(input) => ({ ok: true, message: `Termin ${input.buchungsnummer} ist abgesagt.` })}
      />
    </>
  );
}
