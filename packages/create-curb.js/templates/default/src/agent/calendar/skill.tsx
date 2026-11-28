import { Instruction, Text, Tool, useAgentInfo, z, type SkillMeta } from "curb";
import { listEvents } from "./tools.js";

export const meta = {
  title: "Calendar",
  description: "Use when the user asks what is in their calendar, or when a meeting or appointment is.",
  // The call info this skill reads. A host sets it before the call (set_info), a test in
  // `start.info`; TypeScript checks both against this schema.
  info: z.object({ "user.name": z.string().optional() }),
} satisfies SkillMeta;

/**
 * A skill with its tools in tools.ts next to it, and a short test of its own in
 * calendar.scenario.ts that starts the call inside this skill.
 */
export default function Calendar() {
  const info = useAgentInfo(meta);

  return (
    <>
      <Instruction>{`
        Look the day up with ${listEvents.name} before you say what is in the calendar, and name
        each event with its time. The calendar is read-only: you cannot add or move events.
      `}</Instruction>
      {info["user.name"] ? <Text>{`This is ${info["user.name"]}'s calendar.`}</Text> : null}
      <Tool {...listEvents} />
    </>
  );
}
