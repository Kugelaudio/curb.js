import { Instruction, Procedure, Step, Text, type SkillMeta } from "curb";
import { useStore } from "../agent.js";

export const meta: SkillMeta = {
  title: "Sofortmaßnahmen",
  description: "Die drei verbindlichen Schritte, mit denen jede neue Schadenmeldung beginnt.",
};

/**
 * DEMO POINT 3: a flow is a building block, not a re-drawn diagram.
 *
 * `<Procedure>` is a component. The ordering, the advance tool, and the fact
 * that there is no way forward before completion all live INSIDE the component,
 * not in a prompt sentence and not in a graph somebody redraws per customer.
 * The same ten lines ship to every insurance client.
 *
 * `onComplete` writes to the shared store. What that unlocks is in
 * ../schaden/*, which is demo point 1.
 */
export default function FirstSteps() {
  const completeFirstSteps = useStore((s) => s.completeFirstSteps);
  const firstStepsDone = useStore((s) => s.firstStepsDone);

  return (
    <>
      <Instruction>{`
        Führe die anrufende Person ruhig durch die drei Schritte.
        Arbeite sie der Reihe nach ab und schalte erst weiter, wenn der aktuelle Schritt wirklich beantwortet ist.
        Ein Schaden ist für die anrufende Person ein schlechter Tag: sei knapp, aber nicht hastig.
      `}</Instruction>

      {firstStepsDone ? (
        <Text>
          Der Ablauf ist bereits abgeschlossen. Die Schadenaufnahme steht jetzt zur Verfügung.
        </Text>
      ) : null}

      <Procedure
        title="Verbindliche Reihenfolge bei einer neuen Schadenmeldung"
        advanceTool={{
          name: "schritt_abschliessen",
          description: "Den aktuellen Schritt der Sofortmaßnahmen als erledigt markieren.",
        }}
        onComplete={completeFirstSteps}
        completed={
          // Says WHAT is next, and that the agent does it: one simulated call in six handed the
          // caller to a person here instead (staging, 2026-10-30).
          <Text>Alle drei Schritte sind erledigt. Nimm die Meldung jetzt selbst auf; verbinde dafür nicht weiter.</Text>
        }
      >
        <Step title="Gefahr abwenden und Folgeschäden verhindern">
          Frage passend zum Schaden, ob jetzt noch Gefahr besteht. Bei Wasser: läuft es noch, ist
          Strom in der Nähe, ist die Wohnung bewohnbar? Bei einem Unfall: ist jemand verletzt,
          steht das Fahrzeug sicher? Nenne die Notrufnummer 112, wenn Menschen in Gefahr sind.
          Weise darauf hin, den Schaden zu begrenzen, zum Beispiel den Haupthahn zu schließen oder
          die Unfallstelle abzusichern.
        </Step>
        <Step title="Nachweise sichern, bevor aufgeräumt wird">
          Bitte darum, den Schaden zu fotografieren, bevor etwas beseitigt oder repariert wird,
          und Belege aufzubewahren. Frage das einmal, in einem Satz.
        </Step>
        <Step title="Zur Aufnahme übergehen">
          Fasse kurz zusammen, was passiert ist, und kündige an, dass du die Meldung jetzt
          aufnimmst.
        </Step>
      </Procedure>
    </>
  );
}
