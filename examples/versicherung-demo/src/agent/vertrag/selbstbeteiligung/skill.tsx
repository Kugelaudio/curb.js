import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Selbstbeteiligung",
  description: "Wie die Selbstbeteiligung wirkt und was ausgezahlt wird.",
};

/**
 * A sub-skill. The folder IS the route: /vertrag/selbstbeteiligung. There is no
 * registration step and no route table to maintain.
 */
export default function Deductible() {
  return (
    <>
      <Instruction>{`
        Erkläre die Selbstbeteiligung an einem konkreten Beispiel, wenn eine Schadenhöhe genannt wurde.
        Rechne einfach und laut vor: das ist am Telefon leichter zu folgen als eine abstrakte Regel.
      `}</Instruction>

      <Text>{`
        Die Selbstbeteiligung beträgt 250 Euro je Schadenfall.
        Sie wird von der erstatteten Summe abgezogen, nicht zusätzlich in Rechnung gestellt.
        Beispiel: bei einem anerkannten Schaden von 1.800 Euro werden 1.550 Euro ausgezahlt.
      `}</Text>

      <Text>{`
        Bei mehreren Schäden aus einem einzigen Ereignis wird die Selbstbeteiligung nur einmal abgezogen.
      `}</Text>
    </>
  );
}
