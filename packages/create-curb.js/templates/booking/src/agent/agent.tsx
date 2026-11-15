import {
  Agent,
  GlobalTools,
  Skill,
  Skills,
  SystemPrompt,
  Text,
  Tool,
  createAgentStore,
  defineAgent,
  z,
} from "curb";
import { kugelaudio } from "curb/providers";
import { type Appointment, addAppointment, removeAppointment } from "./calendar.js";

/**
 * Lena, the booking agent of Birch Street Studio, a made-up hair and beauty studio. This file is
 * the agent level, where every call starts: her prompt, the calendar and its tools, and the
 * skill she opens for questions about services. Replace the studio, the services in context/
 * and the in-memory calendar with your own booking system; the shape (system prompt, skills
 * index, tools, store) stays.
 */

/** Opening hours as plain numbers; the calendar is generated from today's date at runtime. */
const FIRST_HOUR = 9;
const LAST_HOUR = 16;
const SERVICES = ["haircut", "coloring", "styling", "manicure"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => `${pad(FIRST_HOUR + i)}:00`);

/** The studio is closed on weekends: an ISO date (YYYY-MM-DD) is open on weekdays only. */
const isOpenDay = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

export const useCalendar = createAgentStore<{
  appointments: Appointment[];
  nextNumber: number;
  add: (appointment: Omit<Appointment, "id">) => Appointment;
  cancel: (id: string) => boolean;
}>("lena", (set, get) => ({
  appointments: [],
  nextNumber: 1,
  add: (appointment) => {
    const { book, created } = addAppointment({ appointments: get().appointments, nextNumber: get().nextNumber }, appointment);
    set({ appointments: book.appointments, nextNumber: book.nextNumber });
    return created;
  },
  cancel: (id) => {
    const { book, removed } = removeAppointment({ appointments: get().appointments, nextNumber: get().nextNumber }, id);
    set({ appointments: book.appointments });
    return removed;
  },
}));

const slotsSchema = z.object({
  date: z.iso.date().describe("The day to check, as YYYY-MM-DD. Work it out from today's date in your context."),
});

const bookSchema = z.object({
  service: z.enum(SERVICES).describe("The service the caller wants."),
  date: z.iso.date().describe("The day, as YYYY-MM-DD."),
  time: z.string().regex(/^\d{2}:00$/).describe("The start time on the hour, 24-hour HH:00, one of the free slots."),
  name: z.string().min(1).describe("The caller's name, as they said it."),
});

const cancelSchema = z.object({
  id: z.string().min(1).describe("The booking number from the list of bookings in your context, for example B-1."),
});

/**
 * Lena's calendar, in her context from the first turn. A booking updates the store, the
 * component re-renders, and the model's context changes. The cancel tool is structural: it does
 * not exist for the model until at least one booking exists.
 */
function Calendar() {
  const appointments = useCalendar((s) => s.appointments);
  const add = useCalendar((s) => s.add);
  const cancel = useCalendar((s) => s.cancel);

  return (
    <>
      <Text>{`Opening hours: weekdays, ${hours[0]} to ${hours[hours.length - 1]} start times, one hour each. Closed on weekends.`}</Text>
      <Text>
        {appointments.length === 0
          ? "No bookings on this call."
          : `Bookings on this call: ${appointments
              .map((a) => `${a.id} ${a.name}, ${a.service}, ${a.date} ${a.time}`)
              .join("; ")}.`}
      </Text>

      <GlobalTools>
        <Tool
          schema={slotsSchema}
          name="list_free_slots"
          description="List the free start times on a given day."
          onSubmit={(input) => {
            if (!isOpenDay(input.date)) return { ok: true, message: `Closed on ${input.date}: no free slots.` };
            const taken = appointments.filter((a) => a.date === input.date).map((a) => a.time);
            const free = hours.filter((time) => !taken.includes(time));
            return { ok: true, message: free.length > 0 ? `Free on ${input.date}: ${free.join(", ")}.` : `Fully booked on ${input.date}.` };
          }}
        />
        <Tool
          schema={bookSchema}
          name="book_appointment"
          description="Book an appointment in a free slot. Call it only after the caller confirmed service, day, time and name."
          onSubmit={(input) => {
            if (!isOpenDay(input.date) || !hours.includes(input.time)) {
              return { ok: false, message: "That is outside opening hours. Offer another slot from list_free_slots." };
            }
            if (appointments.some((a) => a.date === input.date && a.time === input.time)) {
              return { ok: false, message: "That slot is taken. Offer another slot from list_free_slots." };
            }
            const created = add(input);
            return { ok: true, message: `Booked as ${created.id}. Read the day, time and booking number back to the caller.` };
          }}
        />
        {appointments.length > 0 ? (
          <Tool
            schema={cancelSchema}
            name="cancel_appointment"
            description="Cancel a booking from the list of bookings in your context, after the caller asked to cancel it."
            onSubmit={(input) => {
              if (!cancel(input.id)) return { ok: false, message: `No booking ${input.id}. Use a number from the list.` };
              return { ok: true, message: `${input.id} is cancelled.` };
            }}
          />
        ) : (
          <Text>The cancel_appointment tool appears once a booking exists.</Text>
        )}
      </GlobalTools>
    </>
  );
}

export function App() {
  // The providers Lena talks through; their keys live in .env. She listens and speaks in
  // English: another language sets `language` on both stt and tts, with a voice that speaks it.
  return (
    <Agent llm={kugelaudio.llm()} stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts()}>
      <SystemPrompt>{`
        You are Lena, the booking agent of Birch Street Studio, a hair and beauty studio.

        You can:
        - book an appointment for a haircut, coloring, styling or a manicure,
        - cancel a booking made on this call,
        - answer questions about the services and prices.

        Slots exist only in list_free_slots, and a booking exists only after book_appointment answered: never name a free time you did not get from the tool, and never say something is booked before it answered. Before booking, read service, day, time and name back and wait for a yes.

        Greet the caller as Lena from Birch Street Studio and tell them you are an AI assistant.
        Ask what they would like to book. Be warm and brief: one or two sentences per reply, because the caller listens.
      `}</SystemPrompt>
      {/* Each link's routing description is the target skill's meta.description. */}
      <Skills>
        <Skill path="/services">Services and prices</Skill>
      </Skills>
      <Calendar />
    </Agent>
  );
}

export const agent = defineAgent({
  app: App,
  // Voice calls open with Lena's greeting; "user" waits for the caller instead.
  firstTurn: "agent",
  // The calendar works in UTC dates. Set the zone your studio is in, so "today" matches the caller.
  // timeZone: "Europe/Berlin",
  preview: {
    suggestedPrompts: [
      "I'd like a haircut tomorrow",
      "What is free this week?",
      "How much is coloring?",
      "Cancel my booking",
    ],
    chatPlaceholder: "What would you like to book?",
  },
});
