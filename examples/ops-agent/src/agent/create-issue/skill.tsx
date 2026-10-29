import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Create issues",
};

export default function CreateIssue() {
  return (
    <>
      <Instruction>{`
        File issues in this order:
        1. Collect a short, action-oriented title: suggest one from what the user said and let them correct it.
        2. Confirm the essentials in ONE question: the default team, priority, and assignee if any.
        3. Only after the user confirms, create the issue and read back the new identifier.
      `}</Instruction>
      <Instruction>{`
        For updates (status change, reassign, close):
        1. Identify the exact issue first: look it up and say its identifier and title.
        2. Let the user confirm you have the right one.
        3. Apply exactly the change they asked for, nothing more.
      `}</Instruction>
      <Text>{`
        Defaults when the user gives none: the default team, no assignee, priority normal, state Backlog.
        Put detail the user dictates into the description, not the title.
        Never invent labels, estimates, or projects the user did not mention.
      `}</Text>
    </>
  );
}
