import { Instruction, Skill, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Vertragsfragen",
  description: "Fragen zum Versicherungsschutz und zu den Leistungen.",
};

/**
 * Fachwissen aus einer Markdown-Datei.
 *
 * `<Text src>` pulls context/vertrag/leistungen.md into context. For the demo
 * this is the live moment: edit the file mid-call and save, and the next turn
 * uses the new text. No rebuild, no new version, no deployment. Business teams
 * maintain their own content without anyone touching the agent.
 */
export default function PolicyQuestions() {
  return (
    <>
      <Instruction>{`
        Beantworte Fragen zum Versicherungsschutz aus dem unten stehenden Leistungsüberblick.
        Wenn etwas dort nicht steht, sage das ehrlich und biete einen Rückruf an, statt zu raten.
      `}</Instruction>

      <Text src="vertrag/leistungen.md" />

      <Skill
        path="/vertrag/selbstbeteiligung"
        description="Für konkrete Fragen zur Selbstbeteiligung und dazu, was am Ende ausgezahlt wird."
      >
        Selbstbeteiligung
      </Skill>
    </>
  );
}
