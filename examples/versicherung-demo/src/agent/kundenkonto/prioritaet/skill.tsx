import { Instruction, Text, Tool, z, type SkillMeta } from "curb";
import { useStore } from "../../agent.js";

export const meta: SkillMeta = {
  title: "Bevorzugte Bearbeitung",
  description: "Bevorzugte Schadenbearbeitung für verifizierte Bestandskundinnen und -kunden.",
};

const prioritySchema = z.object({
  caseNumber: z
    .string()
    .min(1)
    .describe("Vorgangsnummer des Schadens, zum Beispiel SD-2026-4471."),
  reason: z.string().min(1).describe("Warum die Bearbeitung vorgezogen werden soll."),
});

/**
 * The skill behind the lock.
 *
 * Only discoverable after /kundenkonto has been verified, and since it is
 * linked from nowhere else there is no second route here. The redundant state
 * check below is not distrust of the framework but of the future: if someone
 * later links this skill from a second place, the rule still holds.
 */
export default function PriorityHandling() {
  const customerNumber = useStore((s) => s.customerNumber);

  return (
    <>
      <Instruction>{`
        Erkläre kurz, dass die Bearbeitung vorgezogen werden kann, und frage nach der Vorgangsnummer sowie dem Grund.
      `}</Instruction>

      {customerNumber ? (
        <>
          <Text>{`
            Bevorzugte Bearbeitung bedeutet:
            - Prüfung innerhalb von 24 Stunden statt der üblichen fünf Werktage
            - eine feste Ansprechperson
          `}</Text>
          <Tool
            schema={prioritySchema}
            name="prioritaet_anfordern"
            description="Einen bestehenden Schadenvorgang zur bevorzugten Bearbeitung vormerken."
            success="Der Vorgang wurde zur bevorzugten Bearbeitung vorgemerkt."
            tryWith={{ caseNumber: "SD-2026-4471", reason: "Die Küche steht unter Wasser und ist nicht nutzbar." }}
            onSubmit={(input) => ({
              ok: true,
              message: `Vorgang ${input.caseNumber} wird bevorzugt bearbeitet.`,
              data: { ...input, customerNumber },
            })}
          />
        </>
      ) : (
        <Text>{`
          Diese Fähigkeit setzt ein verifiziertes Kundenkonto voraus.
          Wechsle zum Kundenkonto und verifiziere zuerst Kundennummer und Geburtsjahr.
        `}</Text>
      )}
    </>
  );
}
