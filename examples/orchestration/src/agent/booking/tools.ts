import { defineTool, z } from "curb";

/**
 * The booking skill's tool, as a value: the skill renders it with <Tool {...bookViewing} />, and
 * the scenarios fake it and check it by the same value, so a renamed tool fails `curb check`.
 */
export const bookViewing = defineTool({
  name: "book_viewing",
  description: "Book the viewing.",
  schema: z.object({
    name: z.string().min(1).describe("The caller's name."),
    slot: z.string().min(1).describe("The agreed day and time."),
  }),
  confirm: ({ name, slot }) => `${slot} for ${name}, is that right?`,
  success: "The viewing is booked.",
  // Replace this with a call to your booking system. A test's fake has the type of what it returns.
  onSubmit: (input) => ({ ok: true as const, data: input }),
});
