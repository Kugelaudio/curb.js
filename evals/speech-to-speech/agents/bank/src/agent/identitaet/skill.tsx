import { Instruction, Tool, z, type SkillMeta } from "curb";
import { useKunde } from "../agent.js";

export const meta: SkillMeta = {
  title: "Identität prüfen",
  description: "Identität prüfen: nötig vor jeder Änderung am Konto und vor dem Sperren einer Karte.",
};

/** Fake customers: number and date of birth. */
const KUNDEN: Record<string, { geburtsdatum: string; name: string }> = {
  "40817265": { geburtsdatum: "1979-05-02", name: "Petra Beispiel" },
  "51320948": { geburtsdatum: "1990-11-17", name: "Murat Probe" },
};

export default function Identitaet() {
  const bestaetigen = useKunde((state) => state.bestaetigen);
  return (
    <>
      <Instruction>{`
        Frag nach der achtstelligen Kundennummer und dem Geburtsdatum und prüf beides mit identitaet_pruefen.
        Ohne beide Angaben gibt es keine Änderung am Konto. Nach erfolgreicher Prüfung mach mit dem Anliegen weiter.
      `}</Instruction>
      <Tool
        name="identitaet_pruefen"
        description="Kundennummer und Geburtsdatum des Anrufers prüfen."
        schema={z.object({
          kundennummer: z.string().regex(/^\d{8}$/, "Die Kundennummer hat acht Ziffern.").describe("Kundennummer, acht Ziffern."),
          geburtsdatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Geburtsdatum als JJJJ-MM-TT.").describe("Geburtsdatum, JJJJ-MM-TT."),
        })}
        onSubmit={(input) => {
          const kunde = KUNDEN[input.kundennummer];
          if (!kunde || kunde.geburtsdatum !== input.geburtsdatum) {
            return { ok: true, message: "Nicht bestätigt: Kundennummer und Geburtsdatum passen nicht zusammen. Keine Änderung möglich." };
          }
          bestaetigen(`${kunde.name}, Kundennummer ${input.kundennummer}`);
          return { ok: true, message: `Bestätigt: ${kunde.name}.` };
        }}
      />
    </>
  );
}
