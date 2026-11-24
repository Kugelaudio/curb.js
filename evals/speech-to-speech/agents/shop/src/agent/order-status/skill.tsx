import { Instruction, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Order status",
  description: "Where an order is, when it arrives, and sending its tracking link.",
};

/** Fake orders. */
const ORDERS: Record<string, string> = {
  "48213": "shipped on Monday with the parcel service, arriving Thursday",
  "51007": "being packed in the warehouse, it ships tomorrow",
  "39950": "delivered last Friday",
};

const orderNumber = z.string().regex(/^\d{5}$/, "Order numbers have five digits.").describe("The order number, five digits.");

export default function OrderStatus() {
  return (
    <>
      <Instruction>{`
        Ask for the five-digit order number and look the order up with look_up_order before you say anything about it.
        If the caller wants the tracking link, ask for their email address and send it with send_tracking_link.
      `}</Instruction>
      <Tool
        name="look_up_order"
        description="Look up where an order is."
        schema={z.object({ order_number: orderNumber })}
        onSubmit={(input) => {
          const status = ORDERS[input.order_number];
          return status ? { ok: true, message: `Order ${input.order_number}: ${status}.` } : { ok: true, message: `No order ${input.order_number} found. Ask the caller to check the number.` };
        }}
      />
      <Tool
        name="send_tracking_link"
        description="Email the tracking link of an order to the caller."
        schema={z.object({ order_number: orderNumber, email: z.string().email().describe("The caller's email address.") })}
        onSubmit={(input) => ({ ok: true, message: `Tracking link for ${input.order_number} sent to ${input.email}.` })}
      />
    </>
  );
}
