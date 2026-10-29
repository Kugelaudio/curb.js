import { useState } from "react";
import {
  Instruction,
  Skill,
  Text,
  Tool,
  useAgentInfo,
  z,
  type SkillMeta,
} from "curb";

export const meta: SkillMeta = {
  title: "Member portal",
};

const MEMBER_EMAIL_DOMAIN = "@example.com";

const verifyEmailSchema = z.object({
  email: z
    .string()
    .email("Provide a valid email address.")
    .refine((value) => value.trim().toLowerCase().endsWith(MEMBER_EMAIL_DOMAIN), {
      message: "This email address is not authorized for member access.",
    })
    .describe("Work email address to verify access."),
});

type MemberProfile = {
  email: string;
  name: string;
  memberId: string;
  policyNumber: string;
  address: string;
  phone: string;
  plan: string;
  memberSince: string;
};

function memberProfileFromEmail(email: string): MemberProfile {
  const localPart = email.split("@")[0]?.split(/[.+_-]/)[0] ?? "member";
  const firstName = localPart.charAt(0).toUpperCase() + localPart.slice(1);

  return {
    email,
    name: `${firstName}`,
    memberId: "MBR-284719",
    policyNumber: "POL-8834521",
    address: "42 Riverside Lane, Munich 80331",
    phone: "+49 89 555 0123",
    plan: "Family Plus",
    memberSince: "March 2019",
  };
}

export default function MemberPortal() {
  // External session info (e.g. set by a SIP/voice host from the caller ID).
  // Selector-based: this component only re-renders when this key changes.
  const callerPhone = useAgentInfo((info) => info["caller.phoneNumber"] as string | undefined);

  // Set by the verify tool below. Member content renders only once this is
  // set, so the profile is real whenever it is shown — deriving it
  // unconditionally keeps the JSX free of guards.
  const [email, setEmail] = useState("");
  const profile = memberProfileFromEmail(email);

  return (
    <>
      <Instruction>{`
        Help the user access member-only guidance.
        Collect their work email and verify it before sharing restricted content.
      `}</Instruction>
      {callerPhone ? (
        <Text>{`
          The user is calling from ${callerPhone}.
          Use this to look up their account before asking for details.
        `}</Text>
      ) : null}
      {/* The login mechanic is an ordinary if/else over local state: one
          branch offers the verify tool, the other renders member content.
          The model only ever sees the branch that is currently rendered. */}
      {email ? (
        <>
          {/* Prose with values is one template literal, not JSX text parts: the
              compiler joins adjacent parts with spaces, which would render
              "…com ." with a stray gap. */}
          <Text>{`Signed in as ${email}.`}</Text>
          <Text>{`
            Member profile:
            - name: ${profile.name}
            - member ID: ${profile.memberId}
            - policy: ${profile.policyNumber}
            - plan: ${profile.plan}, member since ${profile.memberSince}
          `}</Text>
          <Text>{`Contact details on file: ${profile.address}, phone ${profile.phone}.`}</Text>
          <Text src="member/unlocked-context.md" />
          {/* A GATED SKILL: linked inside the verified branch, so the model
              can only discover and load it after verification. Its description
              comes from the target's meta.description. */}
          <Skill path="/member-portal/priority-claim">Priority claim</Skill>
        </>
      ) : (
        <>
          <Text>
            Member content stays locked until the user verifies an authorized work email address.
          </Text>
          <Tool
            name="verify_member_email"
            description="Verify a work email address to unlock member content."
            icon="lock"
            schema={verifyEmailSchema}
            onSubmit={(input) => {
              const normalized = input.email.trim().toLowerCase();
              setEmail(normalized);
              return { ok: true, message: `Signed in as ${normalized}.` };
            }}
          />
        </>
      )}
    </>
  );
}
