import { Instruction, Text, z, type SkillMeta } from "curb";
import { ClaimIntake } from "../../claim-intake.js";

export const meta: SkillMeta = {
  title: "Gebäude & Hausrat",
  description: "Schäden an Gebäude und Hausrat.",
};

const propertySchema = z.object({
  name: z.string().min(1).describe("Vollständiger Name der versicherten Person."),
  cause: z
    .string()
    .min(1)
    .describe("Ursache: Leitungswasser, Feuer, Sturm, Hagel oder Einbruch."),
  incident: z.string().min(1).describe("Was passiert ist, in ein bis zwei Sätzen, mit Datum."),
  estimatedAmount: z.string().min(1).describe("Grobe Schätzung in Euro, oder 'unbekannt'."),
});

export default function PropertyClaim() {
  return (
    <>
      <Instruction>{`
        Nimm den Sachschaden auf.
        Kläre zuerst die Ursache: danach richtet sich, was die Versicherung braucht.
        Frage einzeln nach, nicht alles auf einmal.
      `}</Instruction>

      <Text src="schaden/sach.md" />

      <ClaimIntake
        name="sachschaden_aufnehmen"
        description="Einen Schaden an Gebäude oder Hausrat aufnehmen."
        confirm={(input) => `Ich nehme für ${input.name} den Schaden durch ${input.cause} auf, geschätzte Höhe ${input.estimatedAmount}. Stimmt das so?`}
        schema={propertySchema}
      />
    </>
  );
}
