import { evalCase } from "../../../../harness/spec.js";

/** The language the callers speak. */
export const language = "en";

const STATUS = "/order-status";
const RETURNS = "/returns";
const SHIPPING = "/shipping-info";
const EMAIL = "sam.lee@example.com";

export const status = evalCase({
  name: "asks where an order is and wants the link",
  kind: "direct",
  turns: [
    "Hi, where is my order? The number is 48213.",
    "Great, can you email me the tracking link?",
    `It's sam dot lee at example dot com.`,
    "Perfect, thanks. Bye.",
  ],
  firstSkill: STATUS,
  tools: [
    { tool: "look_up_order", args: { order_number: "48213" } },
    { tool: "send_tracking_link", args: { order_number: "48213", email: EMAIL } },
  ],
});

export const returnBoots = evalCase({
  name: "returns boots that are too small",
  kind: "direct",
  caller: {
    goal: "Return the hiking boots from your order because they are too small.",
    knows: "Order number 39950. The item is a pair of hiking boots.",
  },
  firstSkill: RETURNS,
  tools: [
    { tool: "check_return_eligibility", args: { order_number: "39950" } },
    { tool: "start_return", args: { order_number: "39950", reason: "too_small" } },
  ],
  allowed: ["look_up_order"],
});

export const shippingFaq = evalCase({
  name: "asks about shipping to Austria",
  kind: "faq",
  turns: ["How much is shipping to Austria?", "And how long does it take to get there?", "Okay, thanks, that's all."],
  firstSkill: SHIPPING,
  tools: [],
  forbidden: ["look_up_order", "start_return"],
});

export const ambiguous = evalCase({
  name: "unclear: a problem with my order",
  kind: "ambiguous",
  turns: [
    "Hi, I have a problem with my order.",
    "The jacket I got is damaged, I want to send it back.",
    "The order number is 39950.",
    "Yes, please start the return.",
    "Thanks, bye.",
  ],
  firstSkill: RETURNS,
  avoidSkills: [SHIPPING],
  tools: [
    { tool: "check_return_eligibility", args: { order_number: "39950" } },
    { tool: "start_return", args: { order_number: "39950", reason: "damaged" } },
  ],
  allowed: ["look_up_order"],
});

export const switchTopic = evalCase({
  name: "status first, then a return from another order",
  kind: "topic_switch",
  turns: [
    "Can you tell me where order 51007 is?",
    "Okay. Also, I want to return a fleece from order 39950, I changed my mind about it.",
    "Yes, go ahead.",
    "Thanks, that's everything.",
  ],
  firstSkill: STATUS,
  path: [STATUS, RETURNS],
  tools: [
    { tool: "look_up_order", args: { order_number: "51007" } },
    { tool: "check_return_eligibility", args: { order_number: "39950" } },
    { tool: "start_return", args: { order_number: "39950", reason: "changed_mind" } },
  ],
});

export const back = evalCase({
  name: "asks about return postage mid-return, then goes on",
  kind: "back",
  turns: [
    "I'd like to return a rain jacket, it's too large. Order 39950.",
    "Wait, do I have to pay for the return shipping? I'm in Germany.",
    "Good, then please go ahead with the return.",
    "Thanks, bye.",
  ],
  firstSkill: RETURNS,
  path: [RETURNS, SHIPPING],
  tools: [
    { tool: "check_return_eligibility", args: { order_number: "39950" } },
    { tool: "start_return", args: { order_number: "39950", reason: "too_large" } },
  ],
});

export const interrupt = evalCase({
  name: "interrupts to correct the order number",
  kind: "interruption",
  turns: [
    "Can you check my order 48213 for me?",
    { line: "Sorry, sorry, wrong number. It's 51007.", interrupt: true },
    "Okay, thanks, bye.",
  ],
  firstSkill: STATUS,
  tools: [{ tool: "look_up_order", args: { order_number: "51007" } }],
});

export const refuse = evalCase({
  name: "refuses to give an email address",
  kind: "refusal",
  turns: [
    "Where is my order 48213?",
    "Can you send me the tracking link?",
    "Hm, I'd rather not give you my email address.",
    "No, it's fine. Bye.",
  ],
  firstSkill: STATUS,
  tools: [{ tool: "look_up_order", args: { order_number: "48213" } }],
  forbidden: ["send_tracking_link"],
});

export const escalate = evalCase({
  name: "wants a real person",
  kind: "escalation",
  turns: [
    "I want to talk to a real person, this is the third time I'm calling.",
    "It's about order 51007, it was supposed to be here already.",
    "Fine. Bye.",
  ],
  firstSkill: null,
  tools: [{ tool: "request_human" }],
  allowed: ["look_up_order"],
  forbidden: ["start_return"],
});

export const cancel = evalCase({
  name: "wants to cancel an order, which the agent cannot do",
  kind: "escalation",
  turns: ["Hi, I need to cancel my order 51007 before it ships.", "So what can I do?", "Okay, please do that. Bye."],
  firstSkill: null,
  tools: [{ tool: "request_human" }],
  allowed: ["look_up_order", "check_return_eligibility"],
  forbidden: ["start_return"],
});

export const trackSimulated = evalCase({
  name: "tracks an order and gets the link, simulated",
  kind: "multi_step",
  caller: {
    goal: "Find out when your order arrives and get its tracking link by email.",
    knows: `Order number 48213. Email ${EMAIL}.`,
    behaviours: ["everything_at_once"],
  },
  firstSkill: STATUS,
  tools: [
    { tool: "look_up_order", args: { order_number: "48213" } },
    { tool: "send_tracking_link", args: { order_number: "48213", email: EMAIL } },
  ],
});
