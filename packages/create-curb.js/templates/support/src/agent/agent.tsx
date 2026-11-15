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

/**
 * Mara, the customer support agent of Northwind Outdoor, a made-up shop. This file is the agent
 * level, where every call starts: her prompt, the order lookup, the ticket list and the skills
 * she opens only when needed. Replace the shop, the sample orders and the policies in context/
 * with your own; the shape (system prompt, skills index, tools, store) stays.
 */

export type Order = { id: string; item: string; status: "packed" | "shipped" | "delivered"; carrier?: string };
export type Ticket = { id: string; category: string; summary: string; orderId?: string };

/** Sample orders. Replace this with a call to your shop's API inside the find_order tool. */
export const ORDERS: Order[] = [
  { id: "NW-1001", item: "Trail backpack, 35 liters", status: "delivered" },
  { id: "NW-1002", item: "Insulated bottle, two-pack", status: "shipped", carrier: "ParcelPost" },
  { id: "NW-1003", item: "Rain jacket, size M", status: "packed" },
];

export const useSupport = createAgentStore<{
  tickets: Ticket[];
  openTicket: (ticket: Omit<Ticket, "id">) => Ticket;
}>("mara", (set, get) => ({
  tickets: [],
  openTicket: (ticket) => {
    const created = { ...ticket, id: `T-${get().tickets.length + 1}` };
    set((state) => ({ tickets: [...state.tickets, created] }));
    return created;
  },
}));

const findOrderSchema = z.object({
  orderId: z
    .string()
    .min(1)
    .describe("The order number the caller read out, for example NW-1001. Ask for it if they have not said it."),
});

const openTicketSchema = z.object({
  category: z.enum(["damaged", "missing", "return", "other"]).describe("What the caller's problem is about."),
  summary: z.string().min(1).describe("One or two sentences a colleague can act on without calling back."),
  orderId: z.string().optional().describe("The order the ticket is about, when the caller named one."),
});

/**
 * Mara's tools, in her context from the first turn. find_order reads the order list; open_ticket
 * writes to the store, so the ticket count in her context changes with it. The handover tool is
 * structural: it does not exist for the model until a ticket is open, so no prompt can route
 * around it.
 */
function SupportDesk() {
  const tickets = useSupport((s) => s.tickets);
  const openTicket = useSupport((s) => s.openTicket);

  return (
    <>
      <Text>
        {tickets.length === 0
          ? "No tickets opened on this call."
          : `Tickets opened on this call: ${tickets.map((t) => `${t.id} (${t.category})`).join(", ")}.`}
      </Text>

      <GlobalTools>
        <Tool
          schema={findOrderSchema}
          name="find_order"
          description="Look up an order by its number and get its item and delivery status."
          onSubmit={(input) => {
            const order = ORDERS.find((o) => o.id.toLowerCase() === input.orderId.trim().toLowerCase());
            if (!order) {
              return { ok: false, message: `No order ${input.orderId}. Ask the caller to read the number again.` };
            }
            const carrier = order.carrier ? ` with ${order.carrier}` : "";
            return { ok: true, message: `${order.id}: ${order.item}, ${order.status}${carrier}.` };
          }}
        />
        <Tool
          schema={openTicketSchema}
          name="open_ticket"
          description="Open a support ticket for a problem you cannot solve on the call. A colleague follows up by email."
          onSubmit={(input) => {
            const ticket = openTicket(input);
            return { ok: true, message: `Ticket ${ticket.id} opened. Tell the caller a colleague replies by email.` };
          }}
        />
        {tickets.length > 0 ? (
          <Tool
            name="hand_over_to_team"
            description="Tell the caller a person will call back today about the latest ticket. Use it only when the caller asks for a person."
            onSubmit={() => ({
              ok: true,
              message: `A callback is noted on ticket ${tickets[tickets.length - 1].id}. Say that the team calls back today.`,
            })}
          />
        ) : (
          <Text>The hand_over_to_team tool appears once a ticket is open.</Text>
        )}
      </GlobalTools>
    </>
  );
}

export function App() {
  // The providers Mara talks through; their keys live in .env. She listens and speaks in
  // English: another language sets `language` on both stt and tts, with a voice that speaks it.
  return (
    <Agent llm={kugelaudio.llm()} stt={kugelaudio.stt({ language: "en" })} tts={kugelaudio.tts()}>
      <SystemPrompt>{`
        You are Mara, the phone support agent of Northwind Outdoor, an online shop for hiking gear.

        You can:
        - look up an order and tell the caller where it is,
        - explain the return and shipping policies,
        - open a support ticket when you cannot solve the problem on the call.

        State an order's status only after find_order answered, and say a ticket is open only after open_ticket answered. Never promise a refund: refunds are decided by the team after the ticket.

        Greet the caller as Mara from Northwind Outdoor and tell them you are an AI assistant.
        Ask how you can help. Ask for the order number before anything that depends on an order.
        Be warm and brief: one or two sentences per reply, because the caller listens.
      `}</SystemPrompt>
      {/* Each link's routing description is the target skill's meta.description. */}
      <Skills>
        <Skill path="/returns">Returns and refunds</Skill>
        <Skill path="/shipping">Shipping and delivery</Skill>
      </Skills>
      <SupportDesk />
    </Agent>
  );
}

export const agent = defineAgent({
  app: App,
  // Voice calls open with Mara's greeting; "user" waits for the caller instead.
  firstTurn: "agent",
  // Every turn tells the model today's date and time in this zone (default "UTC").
  // timeZone: "Europe/Berlin",
  preview: {
    suggestedPrompts: [
      "Where is order NW-1002?",
      "My backpack arrived damaged",
      "How do I return a jacket?",
      "I want to talk to a person",
    ],
    chatPlaceholder: "How can we help?",
  },
});
