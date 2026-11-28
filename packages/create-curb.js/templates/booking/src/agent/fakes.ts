import { hours, isOpenDay } from "./agent.js";
import { isPersonName } from "./calendar.js";

/**
 * The fakes this agent's scenarios share. `curb test --hermetic` (the CI workflow) runs no tool
 * without a fake, so a test never reaches a real booking system. Each fake answers the way the
 * real tool does on an empty calendar; replace them with what your tests need.
 */
export const bookingFakes = {
  list_free_slots: (input: Record<string, unknown>) => {
    const date = String(input.date);
    if (!isOpenDay(date)) return { ok: true, message: `Closed on ${date}: no free slots.` };
    return { ok: true, message: `Free on ${date}: ${hours.join(", ")}.` };
  },
  book_appointment: (input: Record<string, unknown>) => {
    if (!isPersonName(String(input.name))) {
      return { ok: false, message: `"${String(input.name)}" is not a name. Ask the caller for their name, then book with it.` };
    }
    return { ok: true, message: "Booked as B-1. Read the day, time and booking number back to the caller." };
  },
};
