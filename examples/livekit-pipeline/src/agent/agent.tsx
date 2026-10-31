import { Agent, SystemPrompt, defineAgent } from "curb";
import { pipeline } from "./pipeline";

export function App() {
  return (
    <Agent>
      <SystemPrompt>{`
        You answer the phone for Example Clinic. Keep replies short. To pay an invoice, callers
        transfer to the clinic's IBAN, which you read out when they ask: DE00 0000 0000 0000 0000 00.
      `}</SystemPrompt>
    </Agent>
  );
}

export const agent = defineAgent({ app: App, pipeline });
