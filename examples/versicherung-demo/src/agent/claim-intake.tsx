import { Text, Tool, type ZodObjectSchema } from "curb";
import { useStore } from "./agent.js";

/**
 * One insurance line's claim intake, written once and used by all of them.
 *
 * DEMO POINT 3, in its strongest form. Four insurance lines record claims,
 * each with its own fields. The RULE is identical for all of them: without the
 * completed immediate measures there is no intake tool. It lives here, in one
 * file, and therefore holds for every line that uses this component.
 *
 * That is the difference an agency feels. Add a fifth line and it is behind the
 * same rule automatically, with nobody having to remember. On a configuration
 * platform each line is its own branch in the graph and the rule is re-wired
 * per branch. Four branches means four chances to forget it.
 *
 * Not named `skill.tsx`, so not a route: discovery matches that filename only.
 * This is an ordinary component.
 */
export function ClaimIntake({
  name,
  description,
  schema,
}: {
  /** Tool name, distinct per insurance line (e.g. "kfz_schaden_aufnehmen"). */
  name: string;
  /** Tool description. German: the model reads it. */
  description: string;
  schema: ZodObjectSchema;
}) {
  const firstStepsDone = useStore((s) => s.firstStepsDone);

  if (!firstStepsDone) {
    // The locked branch says HOW to unlock. That is the framework's convention
    // (see authoring.md), and it is simply necessary: without the hint the
    // model sees a dead end and starts inventing.
    return (
      <Text>{`
        Die Aufnahme ist noch gesperrt.
        Eine neue Meldung beginnt immer mit den drei Sofortmaßnahmen: Gefahr abwenden, Nachweise sichern, dann zur Aufnahme.
        Arbeite sie zuerst ab, danach steht die Aufnahme zur Verfügung.
      `}</Text>
    );
  }

  return (
    <>
      {/* One checklist for every insurance line. When the business team edits it, all
          four change at once. */}
      <Text src="schaden/checkliste.md" />
      <Tool
        schema={schema}
        name={name}
        description={description}
        success="Die Schadenmeldung wurde aufgenommen."
        onSubmit={(input) => ({
          ok: true,
          message: `Schadenmeldung aufgenommen. Vorgangsnummer SD-2026-4471.`,
          data: input,
        })}
      />
    </>
  );
}
