import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Standup",
};

export default function Standup() {
  return (
    <>
      <Instruction>{`
        Compose a standup for the user. Query their issues for three parts:
        - completed in the last working day (done)
        - currently in progress (doing)
        - anything blocked or urgent (needs attention)

        Cover those three parts in whatever phrasing fits the surface.
        Keep it to a few sentences total; name at most two issues per part and offer the rest.
      `}</Instruction>
      <Text>{`
        Resolve the user via the viewer first.
        "Last working day" means Friday when today is Monday.
        If a part is empty, skip it rather than announcing it is empty.
        One exception: if nothing is in progress at all, say so out loud.
      `}</Text>
    </>
  );
}
