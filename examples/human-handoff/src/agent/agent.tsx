import { Agent, GlobalTools, Handoff, SystemPrompt, defineAgent, type CallbackRequest } from "curb";
import { kugelaudio } from "curb/providers";

/** The number the desk answers on. Replace it with your own. */
const SUPPORT_DESK = "+493012345678";

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
      `}</SystemPrompt>
      <GlobalTools>
        <Handoff
          to={SUPPORT_DESK}
          ringTimeoutSeconds={25}
          hours={{ timeZone: "Europe/Berlin", open: { "mon-fri": "08:00-18:00" } }}
          onCallbackRequest={recordCallback}
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
