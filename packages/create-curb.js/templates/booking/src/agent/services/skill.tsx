import { Instruction, Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Services and prices",
  description: "Use when the caller asks what the studio offers, how long a service takes or what it costs.",
};

/**
 * A file-backed skill: the price list lives in context/services.md and reaches the model through
 * <Text src>. Edit the markdown and Lena's answers change live, no restart needed.
 */
export default function Services() {
  return (
    <>
      <Instruction>{`
        Answer only from the list below. A service not on it is one the studio does not offer:
        say so, and offer one that is. Prices are what the studio charges; do not add or discount.
      `}</Instruction>
      <Text src="services.md" />
    </>
  );
}
