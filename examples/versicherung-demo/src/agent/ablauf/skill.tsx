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
          // Says WHAT is next, not WHERE to go. Routing is the model's call,
          // decided from the descriptions in the `<Skills>` index; writing
          // "switch to ..." here again would be mechanics in the prompt.
          <Text>Alle drei Schritte sind erledigt. Nimm die Meldung jetzt auf.</Text>
        }
      >
        <Step title="Gefahr abwenden und Folgeschäden verhindern">
          Kläre zuerst, ob aktuell noch Gefahr besteht - etwa laufendes Wasser, Strom in der Nähe
          von Wasser, oder eine unbewohnbare Wohnung. Nenne die Notrufnummer 112, wenn Menschen in
          Gefahr sind. Weise darauf hin, den Schaden nach Möglichkeit zu begrenzen, zum Beispiel
          den Haupthahn zu schließen.
        </Step>
        <Step title="Nachweise sichern, bevor aufgeräumt wird">
          Bitte darum, den Schaden zu fotografieren, bevor etwas beseitigt oder repariert wird,
          und beschädigte Gegenstände vorerst aufzubewahren. Rechnungen und Belege sammeln.
        </Step>
        <Step title="Zur Aufnahme übergehen">
          Fasse kurz zusammen, was passiert ist, und kündige an, dass du die Meldung jetzt
          aufnimmst.
        </Step>
      </Procedure>
    </>
  );
}
