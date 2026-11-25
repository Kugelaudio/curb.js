import { Procedure, Step, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Moving house",
  description: "Registering a move: the customer moves out and takes their contract to a new home.",
};

export default function Moving() {
  return (
    <Procedure
      title="Register a move"
      completed={
        <Tool
          name="register_move"
          description="Register the move with everything the steps collected."
          schema={z.object({
            customer_number: z.string().regex(/^\d{7}$/, "Customer numbers have seven digits.").describe("The customer number, seven digits."),
            move_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "As YYYY-MM-DD.").describe("The day the customer moves out, YYYY-MM-DD."),
            final_reading_kwh: z.number().int().nonnegative().describe("The meter reading on moving day, kWh."),
            new_postcode: z.string().regex(/^\d{5}$/, "Five digits.").describe("The postcode of the new home."),
          })}
          onSubmit={(input) => ({ ok: true, message: `Move registered for ${input.move_date}: the contract continues at ${input.new_postcode}. Confirmation number 66120.` })}
        />
      }
    >
      <Step title="Customer number">Ask for the seven-digit customer number.</Step>
      <Step title="Moving day">Ask on which day the customer moves out.</Step>
      <Step title="Final reading">Ask for the meter reading on moving day. Without it the move cannot be registered.</Step>
      <Step title="New home">Ask for the postcode of the new home.</Step>
    </Procedure>
  );
}
