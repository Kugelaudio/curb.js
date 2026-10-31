import { Instruction, Text, z, type SkillMeta } from "curb";
import { ClaimIntake } from "../../claim-intake.js";

export const meta: SkillMeta = {
  title: "Rechtsschutz",
  description: "Deckungsanfragen bei rechtlichen Auseinandersetzungen.",
};

const legalSchema = z.object({
  name: z.string().min(1).describe("Vollständiger Name der versicherten Person."),
  legalArea: z
    .string()
    .min(1)
    .describe("Rechtsgebiet: Arbeit, Miete, Verkehr, Vertrag oder Sonstiges."),
  facts: z.string().min(1).describe("Der Sachverhalt in zwei bis drei Sätzen."),
  opponent: z.string().min(1).describe("Gegenseite: Name der Person, Firma oder Behörde."),
});

export default function LegalClaim() {
  return (
    <>
      <Instruction>{`
        Nimm die Deckungsanfrage auf.
        Sage klar, dass dies eine Anfrage ist und noch keine Deckungszusage.
        Über die Deckung entscheidet die Prüfung, nicht dieses Gespräch.
      `}</Instruction>

      <Text src="schaden/rechtsschutz.md" />

      <ClaimIntake
        name="rechtsschutz_anfrage_aufnehmen"
        description="Eine Deckungsanfrage im Rechtsschutz aufnehmen."
        confirm={(input) => `Ich nehme für ${input.name} die Anfrage im Bereich ${input.legalArea} gegen ${input.opponent} auf. Stimmt das so?`}
        schema={legalSchema}
      />
    </>
  );
}
