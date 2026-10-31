import { Instruction, Skill, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Schaden melden",
  description: "Einstieg in die Schadenmeldung, verzweigt in die passende Sparte.",
};

/**
 * The hub over the insurance lines.
 *
 * Thin itself: it works out what kind of claim this is and links onward. The
 * lines are NOT listed in the global `<Skills>` index, only here, so each skill
 * appears exactly once in the overview and the model only carries the four
 * lines in context once the call is actually about a claim.
 *
 * That is what scales. Twenty lines would not make the entry skill a sentence
 * longer.
 */
export default function ClaimHub() {
  return (
    <>
      <Instruction>{`
        Kläre zuerst, um welche Art von Schaden es geht, und arbeite dann in der passenden Sparte weiter.
        Frage einmal nach, wenn es unklar ist; rate nicht.
      `}</Instruction>

      <Text>
        Sparten: Gebäude und Hausrat, Kfz, Haftpflicht gegenüber Dritten, und Rechtsschutz.
      </Text>

      <Skill
        path="/schaden/sach"
        description="Für Schäden an Gebäude oder Hausrat: Leitungswasser, Feuer, Sturm, Hagel, Einbruch."
      >
        Gebäude & Hausrat
      </Skill>
      <Skill
        path="/schaden/kfz"
        description="Für alles rund ums Fahrzeug: Unfall, Wildschaden, Glasbruch, Diebstahl."
      >
        Kfz
      </Skill>
      <Skill
        path="/schaden/haftpflicht"
        description="Wenn die versicherte Person einer ANDEREN Person oder deren Eigentum geschadet hat."
      >
        Haftpflicht
      </Skill>
      <Skill
        path="/schaden/rechtsschutz"
        description="Für Deckungsanfragen bei einer rechtlichen Auseinandersetzung. NICHT für Sachschäden."
      >
        Rechtsschutz
      </Skill>
    </>
  );
}
