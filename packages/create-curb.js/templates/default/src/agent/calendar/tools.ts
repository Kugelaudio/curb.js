import { defineTool, z } from "curb";

/**
 * The calendar skill's tools, as values. The skill renders them with <Tool {...listEvents} />,
 * an instruction names one as {listEvents.name}, and a test imports the same value: a renamed
 * tool or a misspelled name fails `curb check` instead of a call.
 */

export type CalendarEvent = { time: string; title: string };

const at = (hour: number, minute: number) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/**
 * Sample events, the same every weekday and none at the weekend. Replace this with a call to
 * your calendar's API: a test fakes the tool, so it never reaches the real calendar.
 */
function eventsOn(day: string): CalendarEvent[] {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return [];
  return [
    { time: at(9, 30), title: "Team stand-up" },
    { time: at(14, 0), title: "Review the quarterly budget" },
  ];
}

export const listEvents = defineTool({
  name: "list_events",
  description: "List the events in the user's calendar on one day.",
  schema: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("The day as YYYY-MM-DD. Work it out from today's date in your context."),
  }),
  // What this returns is the type a test's fake of the tool is checked against.
  onSubmit: async ({ day }) => {
    const events = eventsOn(day);
    return {
      ok: true as const,
      message: events.length === 0 ? `Nothing in the calendar on ${day}.` : `${events.length} event(s) on ${day}.`,
      data: { day, events },
    };
  },
});
