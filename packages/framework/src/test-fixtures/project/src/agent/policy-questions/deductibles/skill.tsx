import { Instruction, Text, type SkillMeta } from "../../../../../../index.js";

export const meta: SkillMeta = {
  title: "Deductibles",
  description: "Use for deductible amounts and cost sharing.",
};

export default function PolicyDeductibles() {
  return (
    <>
      <Instruction>
        Help the user understand deductibles, out-of-pocket amounts, and when a deductible applies to a claim.
      </Instruction>
      <Text>Ask for the policy type and claim scenario before explaining the likely deductible.</Text>
    </>
  );
}
