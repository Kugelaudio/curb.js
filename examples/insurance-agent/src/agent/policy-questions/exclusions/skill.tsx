import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Exclusions",
  description: "Use for exclusions, limits, and cases not covered.",
};

export default function PolicyExclusions() {
  return (
    <>
      <Instruction>
        Help the user identify policy exclusions, limits, waiting periods, and situations that may not be covered.
      </Instruction>
      <Text>Ask for the exact policy language or scenario before explaining possible exclusions.</Text>
    </>
  );
}
