import { Agent, Skill, Skills, SystemPrompt, defineAgent } from "../../../../index.js";

/**
 * TEST-ONLY: an agent whose one skill shows an MCP server inline (`<Mcp url>`), so a test can
 * tell whether building the project's agent connects to it before a call has its own runtime.
 */
function OrdersApp() {
  return (
    <Agent>
      <SystemPrompt>You help customers with their orders.</SystemPrompt>
      <Skills>
        <Skill path="/orders" description="Use for questions about an order.">
          Orders
        </Skill>
      </Skills>
    </Agent>
  );
}

export const agent = defineAgent({ app: OrdersApp });
