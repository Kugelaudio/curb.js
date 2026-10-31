import { Instruction, Text, z, type SkillMeta } from "curb";
import { ClaimIntake } from "../../claim-intake.js";

export const meta: SkillMeta = {
  title: "Haftpflicht",
  description: "Schäden, die die versicherte Person Dritten zugefügt hat.",
};

const liabilitySchema = z.object({
  name: z.string().min(1).describe("Vollständiger Name der versicherten Person."),
  injuredParty: z.string().min(1).describe("Name der geschädigten Person oder Firma."),
  incident: z.string().min(1).describe("Was passiert ist, mit Datum und Ort."),
  estimatedAmount: z.string().min(1).describe("Vom Geschädigten genannte Höhe, oder 'unbekannt'."),
});

/**
 * The line where conversation handling matters most: the caller has damaged
 * someone else's property and is nervous about it. The domain rule behind it,
 * never admit liability on the phone, lives in the Instruction because it is
 * conversation guidance rather than state.
 */
export default function LiabilityClaim() {
  return (
    <>
      <Instruction>{`
        Nimm den Haftpflichtschaden auf.
        Sage der anrufenden Person ausdrücklich, dass sie gegenüber der Gegenseite kein Verschulden anerkennen soll.
        Das prüft die Versicherung.
        Bleib dabei freundlich, nicht belehrend.
      `}</Instruction>

      <Text src="schaden/haftpflicht.md" />

      <ClaimIntake
        name="haftpflicht_schaden_aufnehmen"
        description="Einen Haftpflichtschaden gegenüber Dritten aufnehmen."
        confirm={(input) => `Ich nehme für ${input.name} den Haftpflichtschaden gegenüber ${input.injuredParty} auf. Stimmt das so?`}
        schema={liabilitySchema}
      />
    </>
  );
}
