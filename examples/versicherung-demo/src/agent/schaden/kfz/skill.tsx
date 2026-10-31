import { Instruction, Text, z, type SkillMeta } from "curb";
import { ClaimIntake } from "../../claim-intake.js";

export const meta: SkillMeta = {
  title: "Kfz",
  description: "Unfall, Wildschaden, Glasbruch und Diebstahl am Fahrzeug.",
};

const motorSchema = z.object({
  name: z.string().min(1).describe("Vollständiger Name der versicherten Person."),
  licensePlate: z.string().min(1).describe("Amtliches Kennzeichen, z. B. OS-AB 1234."),
  incident: z.string().min(1).describe("Unfallhergang oder Schadenursache, mit Datum und Ort."),
  opponent: z
    .string()
    .min(1)
    .describe("Beteiligte Gegenseite mit Kennzeichen, oder 'keine' bei einem Alleinschaden."),
  police: z
    .string()
    .min(1)
    .describe("Ob die Polizei aufgenommen hat: 'ja' mit Tagebuchnummer, sonst 'nein'."),
});

export default function MotorClaim() {
  return (
    <>
      <Instruction>{`
        Nimm den Kfz-Schaden auf.
        Kläre früh, ob eine Gegenseite beteiligt war und ob die Polizei aufgenommen hat.
        Beides entscheidet über die weitere Bearbeitung.
      `}</Instruction>

      <Text src="schaden/kfz.md" />

      <ClaimIntake
        name="kfz_schaden_aufnehmen"
        description="Einen Fahrzeugschaden aufnehmen."
        confirm={(input) => `Ich nehme für ${input.name} den Schaden am Fahrzeug ${input.licensePlate} auf. Stimmt das so?`}
        schema={motorSchema}
      />
    </>
  );
}
