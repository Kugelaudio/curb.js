import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Coverage",
  description: "Use for questions about what a policy covers.",
};

export default function PolicyCoverage() {
  return (
    <>
      <Instruction>
        Help the user understand which damages, events, people, or items are covered by their insurance policy.
      </Instruction>
      <Text>Ask for the policy type and the concrete situation before explaining coverage.</Text>
      <Text src="policy/coverage-basics.md" />
    </>
  );
}
