import { Instruction, Text, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "File new claim",
  description:
    "Use ONLY when the policy has NO claim in progress and the user wants to report something new. NOT for chasing an existing claim.",
  icon: "file-plus",
};

const openClaimSchema = z.object({
  incidentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.")
    .describe("The day the incident happened."),
  summary: z
    .string()
    .min(10, "Describe what happened in at least a sentence.")
    .describe("What happened, in the user's own words."),
});

/** Reachable only from the FALSE side of the claim-status lookup. */
export default function FileNewClaim() {
  return (
    <>
      <Instruction>{`
        Collect the incident date and a short account of what happened, then open the claim.
        Confirm the reference number back to the user.
      `}</Instruction>
      <Text>{`
        A new claim needs the incident date and a description.
        Photographs can follow later and do not hold up the filing.
        Claims reported within 24 hours are assessed first.
      `}</Text>
      <Tool
        name="open_new_claim"
        description="Open a new claim for a policy with no claim in progress."
        icon="file-plus"
        schema={openClaimSchema}
        onSubmit={(input) => ({
          ok: true,
          message: `Claim opened for ${input.incidentDate}. Reference CLM-40192.`,
        })}
      />
    </>
  );
}
