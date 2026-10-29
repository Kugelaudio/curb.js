import { Instruction, Text, Tool, z, type SkillMeta } from "../../../../../../index.js";

export const meta: SkillMeta = {
  title: "Priority claim",
  description: "Members only: file an expedited claim with the 24-hour water-damage window.",
};

const priorityClaimSchema = z.object({
  memberId: z.string().min(1).describe("Member ID, e.g. MBR-284719."),
  summary: z.string().min(1).describe("One-sentence summary of the damage."),
});

/**
 * Members-only skill: it is linked INSIDE the member portal's <Gate>, so the
 * model can only discover and load it after a work email was verified.
 */
export default function PriorityClaim() {
  return (
    <>
      <Instruction>
        File an expedited claim for a verified member. Confirm the member ID from their profile —
        never ask them to spell it — and keep the intake to one summary sentence.
      </Instruction>
      <Text>
        Priority claims skip standard intake: they go straight to the priority claims line with a
        24-hour escalation window for water damage.
      </Text>
      <Tool
        schema={priorityClaimSchema}
        name="file_priority_claim"
        description="File an expedited members-only claim."
        success="Priority claim filed — the claims line will call back within the window."
        onSubmit={(input) => ({ ok: true, data: input })}
      />
    </>
  );
}
