import { Instruction, Text, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Track claim",
  description:
    "Use ONLY for a claim that is already open: progress, next milestone, missing documents. NOT for starting a claim.",
  icon: "route",
};

const noteSchema = z.object({
  note: z
    .string()
    .min(4, "Write the update in a full sentence.")
    .describe("What the user wants added to the open claim's file."),
});

/** Reachable only from the TRUE side of the claim-status lookup. */
export default function TrackClaim() {
  return (
    <>
      <Instruction>
        Explain where the open claim stands and what the user needs to do next. Do not offer to start another claim.
      </Instruction>
      <Text>{`
        Claims move through four stages: received, assessment, repair approval, payout.
        An adjuster responds within two working days of the assessment stage.
        Missing documents pause the claim without cancelling it.
      `}</Text>
      <Tool
        name="add_claim_note"
        description="Attach a note from the user to their open claim."
        icon="notebook-pen"
        schema={noteSchema}
        onSubmit={(input) => ({
          ok: true,
          message: `Added to the claim file: ${input.note.trim()}`,
        })}
      />
    </>
  );
}
