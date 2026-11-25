import { Instruction, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Returns",
  description: "Sending items back: checking a return is possible and starting it.",
};

const REASONS = ["too_small", "too_large", "damaged", "not_as_described", "changed_mind"] as const;
const orderNumber = z.string().regex(/^\d{5}$/, "Order numbers have five digits.").describe("The order number, five digits.");

/** Fake orders that can be returned (delivered within 30 days). */
const RETURNABLE = new Set(["39950"]);

export default function Returns() {
  return (
    <>
      <Instruction>{`
        Ask for the order number and check it with check_return_eligibility.
        If the return is possible, ask which item goes back and why, then start it with start_return and give the return number.
      `}</Instruction>
      <Tool
        name="check_return_eligibility"
        description="Check whether an order can still be returned."
        schema={z.object({ order_number: orderNumber })}
        onSubmit={(input) =>
          RETURNABLE.has(input.order_number)
            ? { ok: true, message: `Order ${input.order_number} can be returned until December 20.` }
            : { ok: true, message: `Order ${input.order_number} cannot be returned: it has not been delivered yet, or it is not ours.` }
        }
      />
      <Tool
        name="start_return"
        description="Start the return of one item."
        schema={z.object({
          order_number: orderNumber,
          item: z.string().min(2).describe("The item going back, e.g. hiking boots."),
          reason: z.enum(REASONS).describe("Why it goes back."),
        })}
        onSubmit={(input) =>
          RETURNABLE.has(input.order_number)
            ? { ok: true, message: `Return started for the ${input.item}: return number 70412. The label arrives by email.` }
            : { ok: false, message: `Order ${input.order_number} cannot be returned.` }
        }
      />
    </>
  );
}
