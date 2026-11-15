import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Returns and refunds",
  description: "Use when the caller asks about returning an item, a refund, an exchange or a damaged product.",
};

/**
 * A file-backed skill: the policy lives in context/returns.md and reaches the model through
 * <Text src>. Edit the markdown and Mara's answers change live, no restart needed.
 */
export default function Returns() {
  return (
    <>
      <Instruction>{`
        Answer only from the policy below. For a damaged or wrong item, ask for the order number,
        look it up with find_order, then open a ticket with category "damaged" or "return".
        Never promise a refund or a date: the team decides after the ticket.
      `}</Instruction>
      <Text src="returns.md" />
    </>
  );
}
