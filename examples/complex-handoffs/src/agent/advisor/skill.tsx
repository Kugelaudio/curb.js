import { Instruction, Text, Tool, useSend, useTransferCall, z } from "curb";
import { useCase } from "../store.js";

export const meta = { title: "Advisor", description: "Handing the caller to a person." };

const ADVISOR_DESK = "+493098765432";

export default function Advisor() {
  const customer = useCase((state) => state.customer);
  const transferFailed = useCase((state) => state.transferFailed);
  const setTransferFailed = useCase((state) => state.setTransferFailed);
  const transfer = useTransferCall();
  const send = useSend();

  return (
    <>
      <Instruction>Hand the caller to an advisor with hand_to_advisor. Do not promise a time.</Instruction>
      <Tool
        name="hand_to_advisor"
        description="Record why the caller needs a person, then put them through to the advisor desk."
        schema={z.object({ summary: z.string().min(1).describe("What the caller needs, in one sentence.") })}
        onSubmit={async ({ summary }) => {
          // The person who picks up hears nothing from Curb: leave the note where they read it.
          send.toHost("handoff.note", { customerId: customer?.id, summary });
          const { outcome } = await transfer({
            to: ADVISOR_DESK,
            announce: "One moment, I am putting you through to an advisor.",
          });
          if (outcome === "answered") return { ok: true, message: "The advisor has the call." };
          setTransferFailed();
          return { ok: false, message: `The transfer ended as ${outcome}: nobody took the call.` };
        }}
      />
      {transferFailed ? (
        <Tool
          name="request_callback"
          description="Ask an advisor to call the caller back."
          schema={z.object({ phone: z.string().min(5).describe("The number to call back on.") })}
          success="The callback is recorded."
          onSubmit={(input) => ({ ok: true, data: input })}
        />
      ) : (
        <Text>A callback can be offered only after a failed transfer.</Text>
      )}
    </>
  );
}
