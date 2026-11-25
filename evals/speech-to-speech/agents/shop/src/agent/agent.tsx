import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Tool, defineAgent, z } from "curb";
import { modelUnderTest } from "../../../../harness/model-under-test.js";

/** An outdoor clothing shop's phone line (fake shop, fake data): orders, returns, shipping. */
export function ShopApp() {
  return (
    <Agent s2s={modelUnderTest("en")}>
      <SystemPrompt>{`
        You answer the phone for Larkfield Outdoor, an online shop for outdoor clothing.
        Speak English, friendly and brief: at most two short sentences per reply, one question at a time, no lists.
        You help with where an order is, returns, and shipping questions.
        Order details and returns live only in the shop system: never make up an order status, a date or a return number.
        When a caller asks for a person, or wants something you cannot do, hand them to a colleague.
      `}</SystemPrompt>

      <Skills>
        <Skill path="/order-status" description="Where an order is, when it arrives, and sending its tracking link.">
          Order status
        </Skill>
        <Skill path="/returns" description="Sending items back: checking a return is possible and starting it.">
          Returns
        </Skill>
        <Skill path="/shipping-info" description="Shipping costs, delivery times, countries, and what a return costs.">
          Shipping info
        </Skill>
      </Skills>

      <GlobalTools>
        <Tool
          name="request_human"
          description="Hand the caller to a colleague, who calls back within the hour."
          schema={z.object({ reason: z.string().min(3).describe("What the caller needs, in one sentence.") })}
          onSubmit={(input) => ({ ok: true, message: `A colleague will call back within the hour about: ${input.reason}` })}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({
  app: ShopApp,
  firstTurn: { say: "Larkfield Outdoor, hello! How can I help?" },
  timeZone: "Europe/Berlin",
});
