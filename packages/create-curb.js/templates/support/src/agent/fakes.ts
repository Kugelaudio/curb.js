import { ORDERS } from "./agent.js";

/**
 * The fakes this agent's scenarios share. `curb test --hermetic` (the CI workflow) runs no tool
 * without a fake, so a test never reaches a real order system or ticket queue. Each fake answers
 * the way the real tool does; replace the sample orders with what your tests need.
 */
export const supportFakes = {
  find_order: (input: Record<string, unknown>) => {
    const id = String(input.orderId ?? "").trim().toLowerCase();
    const order = ORDERS.find((o) => o.id.toLowerCase() === id);
    if (!order) return { ok: false, message: `No order ${String(input.orderId)}. Ask the caller to read the number again.` };
    const carrier = order.carrier ? ` with ${order.carrier}` : "";
    return { ok: true, message: `${order.id}: ${order.item}, ${order.status}${carrier}.` };
  },
  open_ticket: { ok: true, message: "Ticket T-1 opened. Tell the caller a colleague replies by email." },
};
