import { Instruction, Text, Tool, z, type SkillMeta } from "curb";
import { useAssistant } from "../agent.js";

export const meta: SkillMeta = {
  title: "About you",
  description: "Use for anything about the user themselves: their name, preferences, facts to remember.",
};

/**
 * A file-backed skill: the profile lives in context/about-you.md and reaches the model's
 * context through <Text src>. Edit the markdown and Juno's knowledge changes live. The
 * remember tool writes to the same shared store her day planner in agent.tsx reads.
 */

const rememberSchema = z.object({
  note: z
    .string()
    .min(1)
    .describe("One short fact or preference in third person, e.g. 'prefers tea over coffee'."),
});

export default function AboutYou() {
  const notes = useAssistant((s) => s.notes);
  const remember = useAssistant((s) => s.remember);

  return (
    <>
      <Instruction>{`
        Answer questions about the user from the profile below and the remembered notes.
        While the profile still holds placeholder text, invite the user once to put their own
        details into context/about-you.md: your knowledge updates live, no restart needed.
      `}</Instruction>

      {notes.length === 0
        ? "No notes remembered yet this session."
        : `Remembered this session: ${notes.join("; ")}.`}

      <Tool
        schema={rememberSchema}
        name="remember"
        description="Save a lasting fact or preference the user just told you about themselves."
        success="Noted. It is now part of the context in every skill that shows it."
        onSubmit={(input) => {
          remember(input.note);
          return { ok: true };
        }}
      />

      <Text src="about-you.md" />
    </>
  );
}
