import { Text, type SkillMeta } from "curb";

export const meta: SkillMeta = {
  title: "Shipping info",
  description: "Shipping costs, delivery times, countries, and what a return costs.",
};

export default function ShippingInfo() {
  return (
    <Text>{`
      Shipping within Germany costs 4.95 euros, and is free from 60 euros.
      Austria and Switzerland cost 9.95 euros; other EU countries 12.95 euros. We do not ship outside Europe.
      Delivery takes 2 to 3 working days in Germany and 4 to 6 working days abroad.
      Returns are free within Germany; from abroad the caller pays the return postage.
      Items can be returned within 30 days of delivery.
    `}</Text>
  );
}
