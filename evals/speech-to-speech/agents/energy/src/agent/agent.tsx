import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Tool, defineAgent, z } from "curb";
import { modelUnderTest } from "../../../../harness/model-under-test.js";

/** An energy supplier's customer line (fake supplier, fake data): readings, tariffs, moving house. */
export function EnergyApp() {
  return (
    <Agent s2s={modelUnderTest("en")}>
      <SystemPrompt>{`
        You answer the customer line of Fernbrook Energy, an electricity supplier.
        Speak English, friendly and brief: at most two short sentences per reply, one question at a time, no lists.
        You take meter readings, explain and price tariffs, and register a move to a new home.
        Customer data and prices come only from the system: never make up a reading, a price or a confirmation.
        Complaints about a bill, and anything you cannot do, go to a colleague who calls back.
      `}</SystemPrompt>

      <Skills>
        <Skill path="/meter-reading" description="Taking a meter reading the customer gives.">
          Meter reading
        </Skill>
        <Skill path="/tariffs" description="What the tariffs are, how they differ, and what one costs a month.">
          Tariffs
        </Skill>
        <Skill path="/moving" description="Registering a move: the customer moves out and takes their contract to a new home.">
          Moving house
        </Skill>
      </Skills>

      <GlobalTools>
        <Tool
          name="request_callback"
          description="Have a colleague call the customer back, for bill complaints and anything else you cannot do."
          schema={z.object({
            name: z.string().min(2).describe("The customer's full name."),
            phone: z.string().min(5).describe("The number to call back, digits only."),
            topic: z.string().min(3).describe("What it is about."),
          })}
          onSubmit={(input) => ({ ok: true, message: `A colleague will call ${input.name} on ${input.phone} today.` })}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({
  app: EnergyApp,
  firstTurn: { say: "Fernbrook Energy, good morning. How can I help?" },
  timeZone: "Europe/Berlin",
});
