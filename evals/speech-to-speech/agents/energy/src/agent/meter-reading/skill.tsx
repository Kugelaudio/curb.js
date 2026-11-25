import { Instruction, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Meter reading",
  description: "Taking a meter reading the customer gives.",
};

export default function MeterReading() {
  return (
    <>
      <Instruction>Ask for the six-digit meter number and the reading in kilowatt hours, read both back, then submit them with submit_meter_reading.</Instruction>
      <Tool
        name="submit_meter_reading"
        description="Record a meter reading."
        schema={z.object({
          meter_number: z.string().regex(/^\d{6}$/, "Meter numbers have six digits.").describe("The meter number, six digits."),
          reading_kwh: z.number().int().nonnegative().describe("The reading in kWh, a whole number."),
        })}
        onSubmit={(input) => ({ ok: true, message: `Reading ${input.reading_kwh} kWh recorded for meter ${input.meter_number}.` })}
      />
    </>
  );
}
