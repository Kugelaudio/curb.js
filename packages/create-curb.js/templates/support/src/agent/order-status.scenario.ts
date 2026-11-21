import { scenario } from "curb/testing";

/**
 * Scripted caller lines: the same words on every run, so this is a gate. It runs once and must
 * pass. Keep one of these for every path that must never break.
 *
 * An order's status exists only in find_order's answer, so a reply that states it shows the
 * lookup ran: no check needs to name the tool.
 */
export default scenario({
  name: "tells where an order is",
  turns: ["Hi, where is my order NW-1002?", "Great, thanks. That is all."],
  expect: ({ said, stateMatches }) => [
    said(/shipped|on (its|the) way|ParcelPost/i),
    // Asking about an order opens no ticket.
    stateMatches("mara", { tickets: [] }),
  ],
});
