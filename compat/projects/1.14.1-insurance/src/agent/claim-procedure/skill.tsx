import {
  Instruction,
  Procedure,
  Step,
  Text,
  Tool,
  z,
  type SkillMeta,
} from "curb";
import { useStore } from "../agent.js";

export const meta: SkillMeta = {
  title: "Claim procedure",
};

const preparedClaimSchema = z.object({
  name: z.string().min(1).describe("Customer full name."),
  email: z
    .string()
    .email("Email address is invalid. Ask the user for a corrected email address.")
    .describe("Customer email address."),
  summary: z.string().min(1).describe("Brief summary of the prepared claim."),
});

export default function ClaimProcedure() {
  // Shared agent-level store (agent.tsx): completing the procedure here also
  // unlocks the claim-intake tools on OTHER pages (e.g. property-damage).
  const { completeProcedure } = useStore();

  return (
    <>
      <Instruction>{`
        Guide the user through the claim reporting procedure in order: safety, evidence, then intake.
        Call complete_claim_procedure_stage only after the current step is satisfied.
      `}</Instruction>
      <Procedure
        title="Three-step claim reporting order"
        advanceTool={{
          name: "complete_claim_procedure_stage",
          description: "Mark the current claim procedure step complete and unlock the next step.",
        }}
        onComplete={completeProcedure}
        completed={
          <>
            <Text>The procedure is complete. Submit the prepared claim summary below.</Text>
            <Tool
              schema={preparedClaimSchema}
              name="submit_prepared_claim"
              description="Submit the prepared claim after the three-step procedure is complete."
              success="Prepared claim was submitted."
              onSubmit={(input) => ({ ok: true, data: input })}
            />
          </>
        }
      >
        <Step title="Confirm safety and prevent further damage">
          Confirm everyone is safe. If emergency services are needed, advise the user to call them first. Ask whether
          further damage can be prevented, such as shutting off water or securing the area.
        </Step>
        <Step title="Collect evidence before filing">
          Ask the user to gather photos, timestamps, receipts, and any reference numbers before starting intake.
        </Step>
        <Step title="Move to claim intake">
          Once safety and evidence are covered, collect the claim details (name, email, a brief summary of the
          claim), then mark this step complete — the submission tool appears after that. Offer a callback only if
          intake cannot continue right now.
        </Step>
      </Procedure>
    </>
  );
}
