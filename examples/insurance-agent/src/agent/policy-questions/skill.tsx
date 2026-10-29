import { Instruction, Skill, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Policy questions",
};

export default function PolicyQuestions() {
  return (
    <>
      <Instruction>
        Help the user understand insurance coverage, deductibles, exclusions, and policy documents.
      </Instruction>
      <Text>
        Ask which policy or coverage topic the user wants to understand before giving specific guidance.
      </Text>
      {/* Link descriptions come from each target skill's meta.description. */}
      <Skill path="/policy-questions/coverage">Coverage</Skill>
      <Skill path="/policy-questions/deductibles">Deductibles</Skill>
      <Skill path="/policy-questions/exclusions">Exclusions</Skill>
    </>
  );
}
