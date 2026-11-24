import { Text, Tool, z, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Tariffs",
  description: "What the tariffs are, how they differ, and what one costs a month.",
};

/** Fake prices: a monthly base fee and a price per kWh, in euros. */
const TARIFFS = { basic: { base: 9, perKwh: 0.31 }, green: { base: 11, perKwh: 0.33 }, flex: { base: 6, perKwh: 0.35 } } as const;

export default function Tariffs() {
  return (
    <>
      <Text>{`
        Basic is the standard tariff with a 12-month term. Green is 100 percent renewable electricity, also 12 months.
        Flex can be cancelled every month but costs more per kilowatt hour.
        Use estimate_monthly_cost for any price: never quote a monthly amount without it.
      `}</Text>
      <Tool
        name="estimate_monthly_cost"
        description="Estimate the monthly cost of a tariff for a yearly consumption."
        schema={z.object({
          tariff: z.enum(["basic", "green", "flex"]).describe("The tariff."),
          annual_kwh: z.number().int().positive().describe("Yearly consumption in kWh."),
        })}
        onSubmit={(input) => {
          const tariff = TARIFFS[input.tariff];
          const monthly = tariff.base + (input.annual_kwh * tariff.perKwh) / 12;
          return { ok: true, message: `${input.tariff} at ${input.annual_kwh} kWh a year: about ${Math.round(monthly)} euros a month.` };
        }}
      />
    </>
  );
}
