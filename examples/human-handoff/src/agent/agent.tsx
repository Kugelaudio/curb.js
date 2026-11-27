import { Agent, GlobalTools, Handoff, SystemPrompt, TransferCallTool, defineAgent, type CallbackRequest } from "curb";
import { kugelaudio } from "curb/providers";

/** The number the desk answers on. Replace it with your own. */
const SUPPORT_DESK = "+493012345678";

/** The billing specialist, asked before a caller is put through. Replace it with your own. */
const BILLING_SPECIALIST = "+493012345679";

/** Where callback requests go. Replace it with your ticket system or inbox. */
async function recordCallback(request: CallbackRequest) {
  console.log(`[support] callback for ${request.name} on ${request.phone} (${request.reason}): ${request.summary}`);
}

export function App() {
  return (
    <Agent stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts({ language: "en" })}>
      <SystemPrompt>{`
        You answer the support line of Example Energy.
        Help with what you can. When the caller asks for a person, hand them over straight away;
        do not try to talk them out of it.
        A billing dispute you cannot settle goes to the billing specialist: ask them first with
        ask_billing_specialist. If they cannot take it, tell the caller and offer a callback.
      `}</SystemPrompt>
      <GlobalTools>
        <Handoff
          to={SUPPORT_DESK}
          ringTimeoutSeconds={25}
          hours={{ timeZone: "Europe/Berlin", open: { "mon-fri": "08:00-18:00" } }}
          onCallbackRequest={recordCallback}
        />
        {/* A warm transfer: the specialist hears a brief first, and the caller is put through only on their yes. */}
        <TransferCallTool
          name="ask_billing_specialist"
          to={BILLING_SPECIALIST}
          description="A billing dispute you cannot settle: ask the billing specialist whether they can take the caller now."
          warm={{ consultTimeoutSeconds: 30 }}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({
  app: App,
  firstTurn: { say: "Example Energy support, how can I help?" },
  timeZone: "Europe/Berlin",
  goals: {
    handed_off: { description: "The caller was handed to a person or offered a callback", tool: "handoff" },
  },
});
