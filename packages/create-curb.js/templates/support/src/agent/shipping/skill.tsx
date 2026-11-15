import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Shipping and delivery",
  description: "Use when the caller asks where a parcel is, how long delivery takes or what shipping costs.",
};

export default function Shipping() {
  return (
    <>
      <Instruction>{`
        For a specific parcel, ask for the order number and use find_order: the lookup is the
        truth, the policy below is only for general questions. If an order is shipped but the
        caller says it never arrived, open a ticket with category "missing".
      `}</Instruction>
      <Text src="shipping.md" />
    </>
  );
}
