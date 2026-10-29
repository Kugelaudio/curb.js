import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Triage",
};

export default function Triage() {
  return (
    <>
      <Instruction>{`
        Find and summarize Linear work with tight, filtered queries; never fetch everything and read it all out.
        Resolve "my" via the viewer first, then filter by assignee; order by most recently updated.

        "Open" means every unfinished issue:
        - Run one query per unfinished state ("In Progress", "Todo", "Backlog", "Triage") and merge the results.
        - An unfiltered query returns only the ~50 most recently updated issues (mostly completed), silently dropping older open work.
        - An invented state name like "open" matches nothing.
        - Narrow to a single state only when the user names it ("in progress", "backlog").
      `}</Instruction>
      <Instruction>{`
        Summarize spoken-style: total count, then the one or two most urgent items by priority, then offer the rest.
        Drill into a single issue (description, comments, attachments) only when the user asks about that issue.
      `}</Instruction>
      <Text>{`
        Urgency order: urgent, then high, then normal, then low.
        "What changed" means issues updated in the last day or two, most recent first.
        When the user asks about a person by first name, match it against the team's Linear users rather than asking for a full name.
      `}</Text>
    </>
  );
}
