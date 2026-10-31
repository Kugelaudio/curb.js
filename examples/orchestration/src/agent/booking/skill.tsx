import { Instruction, Procedure, Step, Tool, createAgentStore, z } from "curb";

export const meta = { title: "Booking", description: "The ordered booking flow." };

const useBooking = createAgentStore<{ ready: boolean; markReady: () => void }>("booking", (set) => ({
  ready: false,
  markReady: () => set({ ready: true }),
}));

export default function Booking() {
  const markReady = useBooking((state) => state.markReady);
  return (
    <>
      <Instruction>Work through the steps in order. Do not ask for two things in one turn.</Instruction>
      <Procedure
        title="Book a viewing"
        advanceTool={{ name: "finish_step", description: "Mark the current step complete." }}
        onComplete={markReady}
        completed={
          <Tool
            name="book_viewing"
            description="Book the viewing."
            schema={z.object({
              name: z.string().min(1).describe("The caller's name."),
              slot: z.string().min(1).describe("The agreed day and time."),
            })}
            confirm={({ name, slot }) => `${slot} for ${name}, is that right?`}
            success="The viewing is booked."
            onSubmit={(input) => ({ ok: true, data: input })}
          />
        }
      >
        <Step title="Get the caller's name">Ask for the caller's name.</Step>
        <Step title="Agree a slot">Offer a weekday between 9 and 17 and agree one.</Step>
      </Procedure>
    </>
  );
}
