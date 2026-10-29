import { Instruction, Text, Tool, z, type SkillMeta } from "../../../../../index.js";
import { useStore } from "../agent.js";

export const meta: SkillMeta = {
  title: "Property damage",
};

const propertyDamageClaimSchema = z.object({
  name: z.string().min(1).describe("Customer full name."),
  email: z
    .string()
    .email("Email address is invalid. Ask the user for a corrected email address.")
    .describe("Customer email address."),
  description: z.string().min(1).describe("Concise description of the damage."),
});

export default function PropertyDamage() {
  // The intake tool is gated on the shared claim store (set by the
  // claim-procedure skill): until the three-step procedure completed, the
  // tool does not exist in the model's context at all — the procedure cannot
  // be routed around. Selector form: read one field of the store.
  const procedureComplete = useStore((claim) => claim.procedureComplete);

  return (
    <>
      <Instruction>
        Help the user report property damage. Collect contact details and a concise damage description.
      </Instruction>
      <Text>Ask for the customer name, email address, and what happened to the property.</Text>
      <Text src="property-damage/intake-checklist.md" />
      {procedureComplete ? (
        <Tool
          schema={propertyDamageClaimSchema}
          name="submit_property_damage_claim"
          description="Submit a property damage claim intake."
          success="Property damage claim intake was accepted."
          onSubmit={(input) => ({ ok: true, data: input })}
        />
      ) : (
        <Text>
          Claim intake is locked: a new claim always starts with the three-step claim procedure
          (safety, evidence, intake). Load the claim-procedure skill and complete it — the intake
          submission unlocks afterwards.
        </Text>
      )}
    </>
  );
}
