import { Instruction, Text, type SkillMeta } from "curb";
import { useAssistant } from "../agent.js";

export const meta: SkillMeta = {
  title: "How this works",
  description: "Use FIRST when the user asks how this demo, this agent, or the framework works.",
};

/**
 * The demo explains itself. Loading this skill IS the demo of skill routing: the model
 * read these instructions on demand because the user asked how things work.
 */
export default function HowThisWorks() {
  const tasks = useAssistant((s) => s.tasks);
  const notes = useAssistant((s) => s.notes);

  return (
    <>
      <Instruction>{`
        Explain how this agent is built, in plain spoken language, a couple of sentences at a time.
        Invite the user to watch the preview's context inspector change while they talk.
      `}</Instruction>

      <Text>{`
        How this project works:
        - The agent is a React tree that renders context and tools for a language model instead of HTML.
        - src/agent/agent.tsx is where every conversation starts: Juno's prompt, her task list and its tools are in her context from the first turn.
        - Each folder under src/agent/ is a skill: instructions and tools the model reads on demand. Reading this skill is how this answer came about.
        - The user's profile is the markdown file context/about-you.md, read by a Text component.
        - Tasks and remembered notes are shared React state: a tool call updates the store, the tree re-renders, and the model's context changes. Tasks on the list right now: ${tasks.length}. Remembered notes: ${notes.length}.
        - Wrapping up the day is gated structurally: the wrap_up_day tool does not exist in the model's context until a task is done.
        - Everything editable lives in src/agent/ and context/, and changes hot-reload into the running conversation.
      `}</Text>
    </>
  );
}
