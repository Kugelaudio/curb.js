import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Text, Tool, defineAgent, useRouter, z } from "curb";
import { kugelaudio } from "curb/providers";
import { CUSTOMERS, useCase } from "./store.js";

function Verify() {
  const setCustomer = useCase((state) => state.setCustomer);
  const router = useRouter();
  return (
    <Tool
      name="verify_customer"
      description="Look the caller up by their customer number."
      schema={z.object({ customerNumber: z.string().min(1).describe("The caller's customer number.") })}
      onSubmit={({ customerNumber }) => {
        const customer = CUSTOMERS[customerNumber];
        if (!customer) return { ok: false, message: "No customer has that number. Ask the caller to check it." };
        setCustomer(customer);
        // The skill arrives as the outcome of this call, in the result the model reads next.
        router.push("/contract");
        return { ok: true, message: `Verified ${customer.name}.` };
      }}
    />
  );
}

export function App() {
  const customer = useCase((state) => state.customer);
  return (
    <Agent stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts({ language: "en" })}>
      <SystemPrompt>{`
        You answer the customer line of Example Energy. Ask for the customer number first.
        Read the matching skill silently, and hand over when the skill tells you to.
      `}</SystemPrompt>
      {customer ? (
        <Skills>
          <Skill path="/contract" description="Use for questions about the caller's plan." tts={kugelaudio.tts({ language: "en", voice: 1072 })}>
            Contract
          </Skill>
          <Skill path="/cancellation" description="Use when the caller wants to cancel." tts={kugelaudio.tts({ language: "en", voice: 1072 })}>
            Cancellation
          </Skill>
          <Skill path="/advisor" description="Use when the caller asks for a person, or nothing here helps.">
            Advisor
          </Skill>
        </Skills>
      ) : (
        <>
          <Text>Locked until the caller is verified: call verify_customer with their customer number.</Text>
          <GlobalTools>
            <Verify />
          </GlobalTools>
        </>
      )}
    </Agent>
  );
}

export const agent = defineAgent({ app: App, firstTurn: { say: "Example Energy, may I have your customer number?" } });
