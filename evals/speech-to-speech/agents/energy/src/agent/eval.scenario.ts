import { evalCase } from "../../../../harness/spec.js";

/** The language the callers speak. */
export const language = "en";

const METER = "/meter-reading";
const TARIFFS = "/tariffs";
const MOVING = "/moving";

const MOVE = { customer_number: "4417203", move_date: "2026-12-15", final_reading_kwh: 23518, new_postcode: "10405" };

export const reading = evalCase({
  name: "gives a meter reading",
  kind: "direct",
  turns: ["Hi, I'd like to give you my meter reading.", "The meter number is 806214.", "It says 23518 kilowatt hours.", "Yes, that's right.", "Thanks, bye."],
  firstSkill: METER,
  tools: [{ tool: "submit_meter_reading", args: { meter_number: "806214", reading_kwh: 23518 } }],
});

export const estimate = evalCase({
  name: "asks what green costs, simulated",
  kind: "direct",
  caller: {
    goal: "Find out roughly what the green tariff would cost you per month.",
    knows: "You use about 3200 kWh a year.",
  },
  firstSkill: TARIFFS,
  tools: [{ tool: "estimate_monthly_cost", args: { tariff: "green", annual_kwh: 3200 } }],
});

export const tariffFaq = evalCase({
  name: "asks how basic and flex differ",
  kind: "faq",
  turns: ["What's the difference between your basic and your flex tariff?", "And which one can I cancel every month?", "Got it, thanks."],
  firstSkill: TARIFFS,
  tools: [],
  allowed: ["estimate_monthly_cost"],
  forbidden: ["submit_meter_reading", "register_move"],
});

export const move = evalCase({
  name: "registers a move step by step",
  kind: "multi_step",
  turns: [
    "Hello, I'm moving and want to take my contract with me.",
    "My customer number is 4417203.",
    "I move out on the 15th of December.",
    "The meter will say about 23518 then.",
    "The new postcode is 10405.",
    "Thank you, bye.",
  ],
  firstSkill: MOVING,
  tools: [{ tool: "register_move", args: MOVE }],
});

export const moveSimulated = evalCase({
  name: "registers a move, simulated",
  kind: "multi_step",
  caller: {
    goal: "Register your move so the electricity contract continues at your new home.",
    knows: "Customer number 4417203. You move out on 15 December 2026. Final meter reading 23518 kWh. New postcode 10405.",
    behaviours: ["off_topic"],
  },
  maxTurns: 12,
  firstSkill: MOVING,
  tools: [{ tool: "register_move", args: MOVE }],
});

export const switchTopic = evalCase({
  name: "reading first, then a tariff price",
  kind: "topic_switch",
  turns: [
    "I want to submit my meter reading: meter 806214, reading 23518.",
    "Yes. And while I have you, what would the green tariff cost me at 2500 kilowatt hours a year?",
    "Okay, thanks. Bye.",
  ],
  firstSkill: METER,
  path: [METER, TARIFFS],
  tools: [
    { tool: "submit_meter_reading", args: { meter_number: "806214", reading_kwh: 23518 } },
    { tool: "estimate_monthly_cost", args: { tariff: "green", annual_kwh: 2500 } },
  ],
});

export const interrupt = evalCase({
  name: "interrupts to correct the reading",
  kind: "interruption",
  turns: [
    "Meter reading for meter 806214: it's 23158.",
    { line: "No wait, I misread it. It's 23518, two three five one eight.", interrupt: true },
    "Yes, correct.",
    "Bye.",
  ],
  firstSkill: METER,
  tools: [{ tool: "submit_meter_reading", args: { meter_number: "806214", reading_kwh: 23518 } }],
});

export const refuse = evalCase({
  name: "moving, but will not give a final reading",
  kind: "refusal",
  turns: [
    "I'm moving and need to register it. Customer number 4417203.",
    "I move out on the 15th of December.",
    "I don't know the reading and I won't be able to read it. Just register it without.",
    "No, I really can't. Just do it.",
    "Fine, forget it. Bye.",
  ],
  firstSkill: MOVING,
  tools: [],
  allowed: ["request_callback"],
  forbidden: ["register_move"],
});

export const complaint = evalCase({
  name: "complains about a bill",
  kind: "escalation",
  turns: [
    "My last bill is way too high, I want someone to look at it.",
    "Robin Example, you can reach me on 0176 5550123.",
    "Thanks. Bye.",
  ],
  firstSkill: null,
  tools: [{ tool: "request_callback", args: { name: "Robin Example", phone: "01765550123" } }],
  forbidden: ["submit_meter_reading"],
});

export const ambiguous = evalCase({
  name: "unclear: calling about my meter",
  kind: "ambiguous",
  turns: [
    "Hi, I'm calling about my meter.",
    "I just want to give you the reading.",
    "Meter 806214, it shows 23518.",
    "Yes.",
    "Bye.",
  ],
  firstSkill: METER,
  avoidSkills: [MOVING],
  tools: [{ tool: "submit_meter_reading", args: { meter_number: "806214", reading_kwh: 23518 } }],
});

export const back = evalCase({
  name: "asks about tariffs mid-move, then goes on",
  kind: "back",
  turns: [
    "I'm moving out on the 15th of December and want to keep my contract. Customer number 4417203.",
    "Quick question first: can I switch to the green tariff at the new place?",
    "Okay. The meter will say 23518 on moving day.",
    "The new postcode is 10405.",
    "Thanks, bye.",
  ],
  firstSkill: MOVING,
  path: [MOVING, TARIFFS],
  tools: [{ tool: "register_move", args: MOVE }],
  allowed: ["estimate_monthly_cost"],
});
