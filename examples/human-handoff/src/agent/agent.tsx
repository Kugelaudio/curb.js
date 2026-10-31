import { Agent, GlobalTools, SystemPrompt, Tool, TransferCallTool, defineAgent, z } from "curb";
import { kugelaudio } from "curb/providers";

/** The number the desk answers on. Replace it with your own. */
const SUPPORT_DESK = "+493012345678";

export function App() {
  return (
    <Agent stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts({ language: "en" })}>
      <SystemPrompt>{`
        You answer the support line of Example Energy.
        Help with what you can. When the caller asks for a person, or you cannot help, call
        transfer_call straight away; do not try to talk them out of it.
        When the transfer fails, tell them nobody could be reached and offer a callback.
      `}</SystemPrompt>
      <GlobalTools>
        <TransferCallTool to={SUPPORT_DESK} ringTimeoutSeconds={25} />
        <Tool
          name="request_callback"
          description="Ask the support desk to call the caller back."
          schema={z.object({
            phone: z.string().min(5).describe("The number to call back on."),
            topic: z.string().min(1).describe("What the caller needs, in one sentence."),
          })}
          success="The callback is recorded. The desk calls back on the next working day."
          onSubmit={(input) => ({ ok: true, data: input })}
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
    reached_person: { description: "The caller reached a person", tool: "transfer_call" },
    callback: { description: "The caller left a callback request", tool: "request_callback" },
  },
});
