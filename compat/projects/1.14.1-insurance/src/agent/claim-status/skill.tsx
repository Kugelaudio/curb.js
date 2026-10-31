import { useState } from "react";
import { Instruction, Skill, Text, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Claim status",
  description:
    "Use FIRST when the user asks about an EXISTING claim, its progress, or its reference number. NOT for reporting new damage.",
  icon: "search",
};

const lookupSchema = z.object({
  policyNumber: z
    .string()
    .regex(/^POL-\d{7}$/, "Policy numbers look like POL-8834521.")
    .describe("The policy number printed on the user's insurance card."),
});

/** Policies whose holders currently have a claim in progress. */
const POLICIES_WITH_OPEN_CLAIMS = new Set(["POL-8834521"]);

/**
 * A routing DECISION written as a plain if/else.
 *
 * The lookup answers one question, and the answer selects which skill the model
 * can reach next: an open claim routes to tracking, no open claim routes to
 * filing. Neither branch is reachable before the lookup runs, so the model
 * cannot skip ahead to the wrong one. This is the whole mechanic, in plain JSX
 * with no framework pattern involved.
 */
export default function ClaimStatus() {
  const [lookup, setLookup] = useState<{ policyNumber: string; hasOpenClaim: boolean } | null>(null);

  return (
    <>
      <Instruction>{`
        Find out whether the user already has a claim in progress before advising them.
        Ask for their policy number and look it up; the lookup decides where the conversation goes next.
      `}</Instruction>

      {lookup === null ? (
        <>
          <Text>
            No policy has been looked up yet. Ask the user for the policy number on their insurance card.
          </Text>
          <Tool
            name="look_up_claim_status"
            description="Look up whether a policy has a claim currently in progress."
            icon="search"
            schema={lookupSchema}
            onSubmit={(input) => {
              const policyNumber = input.policyNumber.trim().toUpperCase();
              const hasOpenClaim = POLICIES_WITH_OPEN_CLAIMS.has(policyNumber);
              setLookup({ policyNumber, hasOpenClaim });
              return {
                ok: true,
                message: hasOpenClaim
                  ? `Policy ${policyNumber} has a claim in progress.`
                  : `Policy ${policyNumber} has no claim in progress.`,
              };
            }}
          />
        </>
      ) : lookup.hasOpenClaim ? (
        <>
          <Text>{`
            Policy ${lookup.policyNumber} has a claim in progress.
            Help the user follow it rather than starting another one.
          `}</Text>
          <Skill path="/claim-status/track-claim">Track the open claim</Skill>
        </>
      ) : (
        <>
          <Text>
            Policy {lookup.policyNumber} has no claim in progress, so anything the user wants to report is a new claim.
          </Text>
          <Skill path="/claim-status/file-new-claim">File a new claim</Skill>
        </>
      )}
    </>
  );
}
