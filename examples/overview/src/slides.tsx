/**
 * The pitch slides, in the same hand as the two drawings: monochrome, drawn
 * rather than laid out, nothing moving.
 *
 * EVERY SLIDE MAKES ONE CLAIM. A previous meeting spent most of its time on
 * framework detail and the prospect left without the point, so each of these
 * carries a single sentence a listener could repeat afterwards, and the graphic
 * exists to make that sentence obvious rather than to add a second idea.
 */

import { Fragment, useEffect, useState } from "react";
import { codeToHtml, type BundledLanguage } from "shiki";
import { Wordmark } from "./wordmark.js";

/**
 * PROPER HIGHLIGHTING, AND ONLY HERE. The rest of the deck is monochrome on
 * purpose, but code is the one place where colour is a convention rather than a
 * decoration: an audience reads tinted tokens as "that is source code", which
 * is the exact claim the comparison slide is making. A flat grey block would
 * have to be argued for; a highlighted one is recognised.
 *
 * Real TextMate grammars rather than a regex approximation, because the two
 * columns are in four languages and a hand-rolled highlighter gets JSON, TSX,
 * TS and YAML subtly wrong in ways an engineer in the room would notice.
 */
const THEME = "github-light";

function Code({
  code,
  lang,
  ours,
}: {
  code: string;
  lang: BundledLanguage;
  ours?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void codeToHtml(code, { lang, theme: THEME }).then((markup) => {
      if (live) setHtml(markup);
    });
    return () => {
      live = false;
    };
  }, [code, lang]);

  const className = ours ? "code code--ours" : "code";

  // Plain text until the grammar resolves. Grammars load as separate chunks, and
  // a deck that flashes empty boxes while someone is mid-sentence over it is
  // worse than one that never colours at all.
  return html ? (
    <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className={className}>{code}</pre>
  );
}

/** Shared page frame: wordmark, headline, and an optional standfirst. */
function Slide({
  title,
  lead,
  display,
  children,
}: {
  /** A node, not a string: hyphenated terms need to be wrapped so they do not
   * break across lines. "No lock-" / "in." on two lines is the sort of thing
   * nobody notices until it is on a projector. */
  title: React.ReactNode;
  lead?: string;
  /** Display scale, for the closing slide only. Every other slide's headline is
   * a label on an argument; the last one IS the argument. */
  display?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="page slide-page">
      <header className="lede">
        <Wordmark />
        <h1 className={display ? "headline headline--display" : "headline"}>{title}</h1>
        {lead ? <p className="standfirst">{lead}</p> : null}
      </header>
      {children}
    </main>
  );
}

/**
 * THE OPENER: A RECAP, AS BULLETS.
 *
 * Five versions got here. Invented pains, then real pains with crosses, then a
 * four-quadrant grid, then two paragraphs of prose — the prose read as a
 * written statement rather than a list of things said, which is not what a
 * recap is for. Bullets are the plain form and the plain form is right: the
 * room scans them in one pass and looks back up.
 *
 * From the call on 20 August. It keeps what is WORKING as well as what is
 * missing: a recap that lists only gaps is an argument wearing one.
 *
 * The question that used to close it ("still right?") is gone. It belongs in
 * the room, not on the slide: printed, it reads as rhetorical, and it is the
 * one moment the deck should hand the floor over rather than script it.
 */
export function PainPoints() {
  /**
   * TWO. What he praised, and the one thing he said would open the door. The
   * commercial line (German hosting, price, support) is gone: it is real, but
   * it is a procurement conversation, and putting it on the opening slide
   * invites the meeting to become one before anyone has seen the product.
   *
   * The rest of what he told us — Osnabrück live, specialised sub-agents, the
   * code-between-agents gap they have since closed — belongs in the
   * conversation. The sub-agent point is better spent on the Skills slide,
   * where it lands as recognition rather than recap.
   */
  /**
   * ALEX'S THREE, from the call on 20 August. These are observations about how
   * they WORK rather than complaints, which is why they set the deck up better
   * than anything I drafted: each one is answered later without the slide
   * having to promise it.
   */
  const POINTS = [
    "Enterprise projects on Parloa, everything else on ElevenLabs agents",
    "Fine-grained control over tool calls and context, through sub-agents",
    "Vendor lock-in in the current platforms, and German hosting matters",
  ];

  return (
    <Slide title="Recap">
      <div className="recap">
        <ul className="recap-list">
          {POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>
    </Slide>
  );
}

/**
 * THE MAIN ARGUMENT — AND THE OBJECTION IT RAISES, ANSWERED ON THE SAME SLIDE.
 *
 * This prospect has already turned down an open-source framework once, because
 * it had no enterprise story, so "open source" heard alone can mean
 * "unsupported" to him. The headline no longer says enterprise-ready, so that
 * answer now rests on the standfirst, on the middle branch of the drawing
 * ("hosted by us, with SLAs"), and on the closing slide.
 */
export function OpenSource() {
  /**
   * Same drawing, in the deck's own hand. The repo and its destinations were
   * hard-stroked outlines left over from an earlier pass, sitting two slides
   * away from the soft surfaces on the comparison slide: one deck, two visual
   * languages. They are surfaces now, lit the same way, with hairline
   * connectors so the lines read as structure rather than as wiring.
   *
   * The caption underneath is gone. "Moving is just another deploy" was the
   * drawing explaining itself, and three destinations hanging off one repo
   * already say it.
   */
  const RUNS = [
    { y: 24, label: "your own infrastructure", note: "your cloud, your region" },
    { y: 182, label: "hosted by us, with SLAs", note: "we run it and support it" },
    {
      y: 340,
      label: "anywhere else you like",
      note: "including a competitor, if we stop earning it",
    },
  ];
  const REPO = { x: 24, y: 118, w: 430, h: 232 };
  const RUN = { x: 700, w: 512, h: 104 };

  return (
    <Slide title={<><span className="nowrap">Open source.</span> <span className="nowrap">No lock-in.</span></>}>
      <figure className="figure">
        <svg
          className="drawing"
          viewBox="0 0 1240 470"
          role="img"
          aria-label="Your repository holds the prompts, the tools and the logic, plus the git history. The same repository runs on your own infrastructure, on KugelAudio's hosting with SLAs, or anywhere else you like."
        >
          <defs>
            {/* The lift the code cards get, as a filter, because these are
                drawn rather than laid out. */}
            <filter id="repo-lift" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#0f0f0e" floodOpacity="0.07" />
              <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#0f0f0e" floodOpacity="0.08" />
            </filter>
            {/* The repo is the subject, so it sits a step further off the page
                than the three places it can run. */}
            <filter id="repo-lift-hero" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#0f0f0e" floodOpacity="0.08" />
              <feDropShadow dx="0" dy="14" stdDeviation="20" floodColor="#0f0f0e" floodOpacity="0.1" />
            </filter>
          </defs>

          {RUNS.map((run) => (
            <path
              key={run.label}
              className="run-edge"
              d={`M ${REPO.x + REPO.w} 234 C 570 234, 600 ${run.y + RUN.h / 2}, ${RUN.x - 8} ${run.y + RUN.h / 2}`}
            />
          ))}

          {/* The subject, so it carries the heavier lift. */}
          <rect
            className="repo-card"
            x={REPO.x}
            y={REPO.y}
            width={REPO.w}
            height={REPO.h}
            rx={22}
            filter="url(#repo-lift-hero)"
          />
          <text className="repo-title" x={REPO.x + 40} y={REPO.y + 66}>
            your repo
          </text>
          {[
            { name: "src/agent/", what: "prompts, tools, logic" },
            { name: "git history", what: "review, diff, roll back" },
          ].map((row, index) => (
            <g key={row.name}>
              <text className="repo-key" x={REPO.x + 40} y={REPO.y + 136 + index * 48}>
                {row.name}
              </text>
              <text className="repo-value" x={REPO.x + 200} y={REPO.y + 136 + index * 48}>
                {row.what}
              </text>
            </g>
          ))}

          {RUNS.map((run) => (
            <g key={run.label}>
              <rect
                className="run-card"
                x={RUN.x}
                y={run.y}
                width={RUN.w}
                height={RUN.h}
                rx={18}
                filter="url(#repo-lift)"
              />
              <text className="run-target" x={RUN.x + 36} y={run.y + 46}>
                {run.label}
              </text>
              <text className="run-note" x={RUN.x + 36} y={run.y + 78}>
                {run.note}
              </text>
            </g>
          ))}
        </svg>
      </figure>
    </Slide>
  );
}

/**
 * THE DIFFERENCES FIRST. An earlier order put the parity rows on top, on the
 * theory that leading with what we do differently invites "but can it even do
 * the basics". The trade was that the slide opened with eight rows ticked
 * identically, and in a short meeting nobody reads to the bottom of a table.
 * Leading with the five that are ours puts the argument where the eye lands,
 * and the parity block underneath answers the doubt for anyone who looks.
 */
export function AgainstElevenLabs() {
  /**
   * EVERY ROW CHECKED AGAINST THEIR OWN DOCUMENTATION, August 2026. Three
   * claims on earlier drafts were simply false, and a prospect who knows the
   * product will catch one and stop believing the rest. What survived:
   *
   *  - config-as-code: THEY HAVE IT (agents API + config in version control)
   *  - own infrastructure: THEY HAVE IT — "the full ElevenAgents runtime can
   *    run in your VPC", plus on-prem in early access since April 2026. Off
   *    the table now, but the finding stands: do not put it back as a
   *    differentiator.
   *  - server tools: execute on a webhook server the customer hosts, separate
   *    from the agent calling them (elevenlabs.io/docs — server-tools)
   *  - speech stack: LLM is swappable ("bring your own"), but ASR and TTS are
   *    theirs alone. Re-checked against the create-agent API: `asr.provider`
   *    takes `elevenlabs` or `scribe_realtime`, and `tts.model_id` takes
   *    `eleven_turbo_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2`,
   *    `eleven_flash_v2_5`, `eleven_multilingual_v2` or
   *    `eleven_v3_conversational`. Every value on both lists is their own
   *    model. This is the one row tied to a pain the prospect stated himself,
   *    and it is why "the speech model ITSELF" is worded to exclude the LLM.
   *
   *  - agent testing: THEY HAVE IT, and it is good - simulation tests, next
   *    reply tests, tool-call assertions, tool mocking, all config-as-code
   *    under `tests.json`. What differs is that a test runs against a deployed
   *    agent and its criteria are judged by an LLM, which is why the row says
   *    "locally, with no model judging them" rather than anything about
   *    whether they can be tested at all.
   *  - workflows: THEY HAVE THEM. Their subagent nodes scope tools and their
   *    edges can branch on an expression, so a graph does reach different tool
   *    sets at runtime. The scoping row is about the mechanism: theirs is a
   *    graph you author ahead of time, with a node per combination, and ours
   *    is code that runs. It replaced a separate routing row because both
   *    reduced to that same one fact.
   *
   * CAVEAT ON THE TESTING ROW. curb has 480 tests of its own, but it exports no
   * test helper and documents no story for testing a user's agent. The row is
   * true structurally - the agent is a React tree you can render and assert on
   * - but there is nothing to demo yet. Do not offer to show it.
   */
  const ROWS: Array<{ feature: string; them: boolean; us: boolean }> = [
    { feature: "Tools and context scoped by your own code", them: false, us: true },
    { feature: "Tool logic runs in the agent, not a webhook service", them: false, us: true },
    { feature: "Tests run locally, with no model judging them", them: false, us: true },
    { feature: "Swap the speech model itself, keep the agent", them: false, us: true },
    { feature: "Open-source runtime you can fork", them: false, us: true },
    { feature: "Tool / function calling", them: true, us: true },
    { feature: "Interruption handling", them: true, us: true },
    { feature: "Telephony", them: true, us: true },
    { feature: "Agent defined as code, in version control", them: true, us: true },
    { feature: "Bring your own LLM", them: true, us: true },
  ];

  return (
    <Slide
      title="Where we differ"
    >
      <table className="matrix">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">ElevenLabs</th>
            <th scope="col" className="matrix-ours">
              curb.js
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row, index) => (
            <tr
              key={row.feature}
              className={
                index > 0 && row.them !== ROWS[index - 1]!.them ? "matrix-row--gap" : undefined
              }
            >
              <th scope="row">{row.feature}</th>
              <td>{row.them ? <Tick /> : <Dash />}</td>
              <td className="matrix-ours">{row.us ? <Tick /> : <Dash />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Slide>
  );
}

function Tick() {
  return (
    <svg className="tick-mark" viewBox="0 0 24 24" aria-label="yes">
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  );
}

function Dash() {
  return (
    <svg className="dash-mark" viewBox="0 0 24 24" aria-label="no">
      <path d="M6 12h12" />
    </svg>
  );
}

/**
 * THE SAME AGENT, BOTH WAYS. Abstracted to shapes on purpose: the point is the
 * VOLUME and the number of places, which anyone can see at a glance, and real
 * code would invite reading instead of comparing. A side-by-side screen
 * recording would be stronger still; this is the version that exists today.
 */
/**
 * The agent both columns describe.
 *
 * THIS IS THE POINT OF THE SLIDE. ElevenLabs draws this graph for you in a
 * workflow editor; curb produces it from the file tree and the `<Skill>` links
 * inside the prose. Same three nodes, same two branches, same condition on the
 * edges. Booking rather than insurance because nobody needs the domain
 * explained before the branch makes sense. The comparison underneath is therefore about what it COSTS to get
 * here, not about what you get, which is a much harder argument to wave away.
 */
function AgentGraph() {
  /**
   * THREE INDEPENDENT RULES, NOT A BRANCH. A single branch is the shape a
   * workflow editor is genuinely good at, so comparing on one argued from the
   * competitor's strength. These four conditions are independent of each
   * other, which is where the two models actually diverge: conditions compose
   * additively in a render and multiplicatively in a graph.
   *
   * NO LOOKUP TOOL. An earlier draft had the model ask for a phone number and
   * call `look_up_caller`, which is a round trip nobody would build on an
   * inbound call and which hands the model a job your own code should do.
   * Both sides now open with the caller already resolved: theirs through
   * `dynamic_variables`, ours through a hook. The only thing left between the
   * two columns is whether that data can gate a tool.
   */
  const RULES = [
    { when: "they have an appointment", tool: "reschedule" },
    { when: "more than 24 hours away", tool: "cancel_appointment" },
    { when: "an invoice is unpaid", tool: "send_payment_link" },
  ];
  const TRUNK_X = 26;
  const CHILD_X = 58;
  const CHILD_W = 214;
  const CHILD_H = 40;
  const first = 104;
  const step = 76;
  const y = (index: number) => first + index * step;

  return (
    <figure className="agent-graph">
      <svg
        viewBox="0 0 280 388"
        role="img"
        aria-label="One appointments agent whose three tools each appear only under their own condition: rescheduling once the caller has an appointment, cancelling only more than twenty-four hours ahead, and sending a payment link only when an invoice is unpaid."
      >
        <defs>
          {/* The same lift the code cards get, expressed as a filter because
              these nodes are drawn rather than laid out. */}
          <filter id="node-lift" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#0f0f0e" floodOpacity="0.07" />
            <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#0f0f0e" floodOpacity="0.075" />
          </filter>
        </defs>

        {/* Hairline, not ink: the connectors are structure, the nodes are the
            subject. Drawing both at full weight read as a wiring diagram. */}
        <path className="gtrunk" d={`M ${TRUNK_X} 50 V ${y(RULES.length - 1) + CHILD_H / 2}`} />
        {RULES.map((rule, index) => (
          <path
            key={rule.tool}
            className="gtrunk"
            d={`M ${TRUNK_X} ${y(index) + CHILD_H / 2} H ${CHILD_X}`}
          />
        ))}

        <rect className="gnode" x={6} y={6} width={190} height={44} rx={13} filter="url(#node-lift)" />
        <text className="gnode-label" x={101} y={34} textAnchor="middle">
          appointments
        </text>

        {RULES.map((rule, index) => (
          <g key={rule.tool}>
            <text className="gcondition" x={CHILD_X + 2} y={y(index) - 9}>
              {rule.when}
            </text>
            <rect
              className="gnode"
              x={CHILD_X}
              y={y(index)}
              width={CHILD_W}
              height={CHILD_H}
              rx={12}
              filter="url(#node-lift)"
            />
            {/* Mono, because these are identifiers you could type. It also ties
                each node to the same name in both columns. */}
            <text
              className="gnode-label gnode-label--tool"
              x={CHILD_X + CHILD_W / 2}
              y={y(index) + 25}
              textAnchor="middle"
            >
              {rule.tool}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

export function CodeCompare() {
  /**
   * ONE FEATURE, TRACED THROUGH BOTH STACKS. Every box on this slide is the
   * same requirement: find out whether the caller already has an appointment,
   * and do not let them book a second one if they do.
   *
   * THE LEFT COLUMN IS A REAL ELEVENLABS AGENT, not a caricature of one. The
   * field names are theirs and current: agents are config-as-code through
   * `elevenlabs agents push`, tools are separate objects referenced by
   * `prompt.tool_ids` (inline `prompt.tools` is deprecated), and `api_schema`
   * carries a real JSON Schema. Getting any of this wrong would be the fastest
   * way to lose a technical room, and the honest version is the stronger
   * argument anyway: what is missing is not features, it is a place to put a
   * CONDITION. The branch on the right is an `if`; on the left it can only be
   * asked for, in prose, inside a JSON string.
   *
   * THE COMPARISON IS ABOUT WHERE THE LOGIC LIVES, NOT ABOUT CAPABILITY.
   * ElevenLabs can express this branch and the left column shows them doing
   * it properly, with a real workflow graph. What differs is that their graph
   * is a separate artefact keyed by node and edge ids, their tool is a
   * separately registered object reached by id, and its body is a service you
   * host — while ours is the component that already holds the instructions,
   * with the condition written in the language the rest of the app is in.
   *
   * NOTHING HERE IS PADDING. An earlier draft ended with an `infra/deploy.yaml`
   * and that was a thumb on the scale: a curb agent is a long-running process
   * you deploy too, so hosting is symmetric.
   *
   * THE TYPE IS SIZED TO BE SEEN, NOT READ, and both columns are set at the
   * same size. Shrinking only theirs would win the slide and lose the room.
   */
  const THEIRS: Array<{
    file: string;
    lang: BundledLanguage;
    code: string;
  }> = [
    {
      // THE GENEROUS VERSION. Their subagent node defines which tools are
      // available, so making availability conditional means adding nodes: four
      // independent flags is up to sixteen states. Keeping it to one node is
      // the sane choice, and it is the one shown — which puts the four rules in
      // the prompt, where they are asked for rather than enforced. Both halves
      // of that fork are true of their model, and showing the sane half is what
      // keeps this fair.
      file: "agent_configs/appointments.json",
      lang: "json" as const,
      code: `{
  "name": "appointments",
  "conversation_config": {
    "agent": {
      "prompt": {
        "prompt": "You are booking for the practice. The caller is {{caller_name}}. Only offer to reschedule if they have an appointment. Do NOT offer to cancel within 24 hours of the start time. If {{unpaid_invoice}} is true, mention it before booking anything.",
        "llm": "gemini-2.5-flash",
        "tool_ids": [
          "tool_3b19m8q2w6xxz4trv7ph",
          "tool_5c07d1s9y2kkn8gwe3ju",
          "tool_9f42h6t3b8ppr1mzc5ka"
        ]
      }
    }
  }
}`,
    },
    {
      // ALL THREE, WRITTEN OUT. A single config with a card stack behind it
      // read as one file with a flourish, which under-sold their side by two
      // configs. Every tool the agent attaches is its own registered object
      // with its own schema and its own endpoint, and the only honest way to
      // show that is to show them.
      file: "tool_configs/",
      lang: "jsonc" as const,
      code: `// reschedule.json
{ "type": "webhook", "name": "reschedule",
  "description": "Move the appointment to a new time.",
  "api_schema": { "url": "https://hooks.acme.de/appointments/reschedule",
    "method": "POST", "request_body_schema": { "type": "object",
      "properties": { "starts_at": { "type": "string" } } } } }

// cancel_appointment.json
{ "type": "webhook", "name": "cancel_appointment",
  "description": "Cancel the caller's appointment.",
  "api_schema": { "url": "https://hooks.acme.de/appointments/cancel",
    "method": "POST", "request_body_schema": { "type": "object",
      "properties": { "appointment_id": { "type": "string" } } } } }

// send_payment_link.json
{ "type": "webhook", "name": "send_payment_link",
  "description": "Text a link to pay the invoice.",
  "api_schema": { "url": "https://hooks.acme.de/invoices/payment-link",
    "method": "POST", "request_body_schema": { "type": "object",
      "properties": { "invoice_id": { "type": "string" } } } } }`,
    },
    {
      file: "tools.json",
      lang: "json" as const,
      code: `{
  "tools": [
    { "config": "tool_configs/reschedule.json", "id": "tool_3b19m8q2w6xxz4trv7ph" },
    { "config": "tool_configs/cancel_appointment.json", "id": "tool_5c07d1s9y2kkn8gwe3ju" },
    { "config": "tool_configs/send_payment_link.json", "id": "tool_9f42h6t3b8ppr1mzc5ka" }
  ]
}`,
    },
    {
      file: "webhook-server/index.ts",
      lang: "typescript" as const,
      code: `import express from "express";
import * as practice from "./practice.js";

const app = express().use(express.json());

app.post("/appointments/reschedule", (req, res) => res.json(practice.move(req.body)));
app.post("/appointments/cancel", (req, res) => res.json(practice.cancel(req.body)));
app.post("/invoices/payment-link", (req, res) => res.json(practice.sendLink(req.body)));

app.listen(process.env.PORT ?? 8080);`,
    },
  ];

  const OURS = `export default function Appointments() {
  const caller = useCaller();

  return (
    <>
      <Instruction>
        You are booking for the practice. The caller is {caller.name}.
      </Instruction>

      {caller.appointment && (
        <Tool
          name="reschedule"
          description="Move the appointment to a new time."
          schema={z.object({ startsAt: z.string() })}
          onSubmit={({ startsAt }) => move(caller.appointment, startsAt)}
        />
      )}

      {caller.appointment && hoursUntil(caller.appointment) > 24 && (
        <Tool
          name="cancel_appointment"
          description="Cancel the caller's appointment."
          onCall={() => cancel(caller.appointment)}
        />
      )}

      {caller.unpaidInvoice && (
        <>
          <Instruction>Mention it before booking anything.</Instruction>
          <Tool
            name="send_payment_link"
            description="Text a link to pay the invoice."
            onCall={() => sendLink(caller)}
          />
        </>
      )}
    </>
  );
}`;

  return (
    <Slide
      title="Rules the agent cannot break"
    >
      <div className="versus versus--code">
        <section>
          <h2 className="versus-label">ElevenLabs</h2>
          <div className="files files--many">
            {THEIRS.map((entry) => (
              <div className="file" key={entry.file}>
                <p className="file-name">{entry.file}</p>
                <Code code={entry.code} lang={entry.lang} />
              </div>
            ))}
          </div>
        </section>

        <AgentGraph />

        <section>
          <h2 className="versus-label">With curb.js</h2>
          {/* NOT "one file" - curb is a project: skills under src/agent, their
              markdown alongside, orchestration next to it. The honest claim is
              that it is ONE codebase running as ONE process, with no separate
              tool service to deploy and keep in step. Overstating it is the
              fastest way to lose the room to a single follow-up question. */}
          <div className="files">
            <div className="file file--ours">
              <p className="file-name">src/agent/appointments/skill.tsx</p>
              <Code code={OURS} lang="tsx" ours />
            </div>
          </div>
        </section>
      </div>
    </Slide>
  );
}

/**
 * HOW A SKILL BECOMES TURN-BASED CONTEXT.
 *
 * THE QUESTION came from the room and it is about the TRANSFORM, not about the
 * loop: a skill is a file, so what does the model actually receive? An earlier
 * version of this slide showed three turns with different tool lists, which
 * demonstrated the CONSEQUENCE without ever showing the tree — the mechanism
 * was still being taken on trust.
 *
 * SO THE SLIDE IS THE MAPPING. Every row is a real one, read off compiler.ts:
 * `<SystemPrompt>` lands in `systemPrompt`, `<Instruction>` in `instructions`,
 * `<Text>` in `content`, `<Tool>` in the tool registry, `<Skill>` in `links`
 * (which is also what joins the loadable index). Nothing here is a metaphor for
 * what happens; it is what happens.
 *
 * THE LAST ROW IS THE ONE THAT MATTERS. A condition is not compiled into
 * anything the model can inspect — it decides whether the rows above it exist
 * at all. That is why it is drawn dashed and lands on "or nothing at all",
 * and it is the honest answer to "can the model route around the rule".
 *
 * Typographic rather than boxed: the deck already spends cards on files, and a
 * mapping is two lists and the lines between them.
 */
export function TurnLoop() {
  /** Left is authored, right is what a turn's request carries. Rows are 1:1 on
   * purpose — the transform really is this flat. */
  const ROWS = [
    { from: "<SystemPrompt>", to: "the system prompt", gate: false },
    { from: "<Instruction>", to: "instructions the model follows", gate: false },
    { from: "<Text>", to: "knowledge it can quote", gate: false },
    { from: "<Tool>", to: "a callable tool, with its schema", gate: false },
    { from: "<Skill>", to: "a skill it is allowed to open", gate: false },
    { from: "{caller.unpaidInvoice && \u2026}", to: "\u2026 or none of the above", gate: true },
  ];
  const TOP = 118;
  const STEP = 62;

  return (
    <Slide title="How a skill becomes context">
      <figure className="figure">
        <svg
          className="drawing"
          viewBox="0 0 1240 470"
          role="img"
          aria-label="Each authored component compiles into one part of a single turn's request: SystemPrompt becomes the system prompt, Instruction becomes instructions, Text becomes knowledge, Tool becomes a callable tool with its schema, Skill becomes a skill the model may open, and a condition decides whether any of them are there at all."
        >
          <text className="map-head" x={500} y={56} textAnchor="end">
            what you write
          </text>
          <text className="map-head" x={740} y={56}>
            what the model gets, this turn
          </text>
          <line className="map-rule" x1={60} y1={78} x2={1180} y2={78} />

          {ROWS.map((row, index) => {
            const y = TOP + index * STEP;
            return (
              <g key={row.from}>
                <text className={row.gate ? "map-from map-from--gate" : "map-from"} x={500} y={y} textAnchor="end">
                  {row.from}
                </text>
                <path
                  className={row.gate ? "map-link map-link--gate" : "map-link"}
                  d={`M 524 ${y - 7} H 716`}
                />
                <text className={row.gate ? "map-to map-to--gate" : "map-to"} x={740} y={y}>
                  {row.to}
                </text>
              </g>
            );
          })}
        </svg>
      </figure>

      <p className="map-note">
        One render per turn, and a tool call triggers the next one. The same files
        compile to a different context every time, so the model never sees a rule
        it is supposed to be ignoring.
      </p>
    </Slide>
  );
}

/**
 * WHAT THE MODEL ACTUALLY RECEIVES, TURN BY TURN.
 *
 * TWO COLUMNS AND A RELATIONSHIP. The conversation runs down the left; the
 * skills sit on the right as objects you can point at; lines show them being
 * pulled in. An earlier version collapsed all of it into one column of
 * `<current_context>` text, which left the skill invisible and the
 * transformation — the entire point — impossible to see.
 *
 * THE INDEX IS WHY ANY OF THIS HAPPENS. `context.links` compiles to
 * `available_skill:` lines AND installs the `read_skill` runtime tool
 * (runtime.ts), whose parameter description is the list of paths it will
 * accept. So the index is how the model knows `policies` exists at all, and
 * `read_skill` is how it asks for it. Without both on the slide the second
 * skill just appears, and the room is left assuming magic.
 *
 * THE SKILLS LOOK LIKE THE SKILLS SLIDE — same prose bars, same tool squares —
 * so the object is recognised rather than explained. Inside the transcript the
 * same shape is ghosted, because that block IS the skill flattened into text.
 *
 * Read off llm/serialize-input.ts: system prompt once, real turns accumulate,
 * compiled context appended as one synthetic user message at the END and
 * rebuilt each turn while everything above stays byte-identical.
 */
export function TurnTaking() {
  const FRAME_X = 108;
  const FRAME_W = 520;
  const PADDING = 24;
  const INNER = FRAME_X + PADDING;
  const INNER_R = FRAME_X + FRAME_W - PADDING;
  /* The gap has to hold the edge label, which measures 163 units at 14px in
     the browser. 102 — what it was — is not a near miss, it is half.
     The clear span is what matters and it is NOT the gap: the label has to
     clear the window BORDER at FRAME_R, not the context block 24 units inside
     it. Centring on the block put the first word under the frame. So:
     163 for the label plus 24 either side, plus the 24 of frame padding.
     The frame cannot give the room back — the widest bubble already reaches
     585 of its 604 — so the viewBox widens instead. Vertical space is what
     this slide has spare. */
  const GAP = 163 + 48 + 24;
  const CARD_W = 412;
  const FRAME_R = 108 + 520;
  const RIGHT = FRAME_R - 24 + GAP;
  const PAD = 38;
  const INSET = PAD / 2;

  /**
   * ONE FRAME, BECAUSE IT IS ONE REQUEST.
   *
   * Drawn as a chat above and a card below, this read as two separate objects
   * that happened to share a slide, and the system prompt was a label floating
   * with nothing under it. But the system prompt, the turns and the compiled
   * context are all the SAME request — that is the thing worth seeing, and it
   * is why the block being last means anything.
   *
   * So everything sits inside one framed window, in the order it is sent, and
   * the frame is defined by its border rather than a heavy fill, which leaves
   * the depth scale free to carry role: what the caller says sits below the
   * window, the agent's own voice is white above it, and the compiled block is
   * white and lifted — the only thing in the window that rises.
   *
   * The system prompt used to lead as its own row. It was a static string on a
   * slide about what CHANGES every turn, so it bought nothing and pushed everything
   * else down; the window starts at the conversation now.
   */
  const WRENCH =
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z";

  const bars = (x: number, y: number, widths: number[], cls = "prose") =>
    widths.map((w, i) => (
      <rect className={cls} key={`${x}-${y}-${i}`} x={x} y={y + i * 14} width={w} height={5} rx={2.5} />
    ));

  const tool = (x: number, y: number, size: number, tone: "a" | "b", key: string) => (
    <g key={key} transform={`translate(${x} ${y})`}>
      <rect className={`tool-sq tool-sq--${tone}`} width={size} height={size} rx={size * 0.28} />
      <g transform={`translate(${size * 0.22} ${size * 0.22}) scale(${size * 0.023})`}>
        <path className="tool-ic" d={WRENCH} />
      </g>
    </g>
  );

  /* Widths are the rendered width of each string at 17px, measured in the
     browser: guessed ones ran 25 to 30 per cent wide. */
  const TURNS: Array<{ text: string; side: "l" | "r"; tw: number; call?: boolean }> = [
    { text: "“Hello, I’m your assistant”", side: "l", tw: 196 },
    { text: "“I need help with my account”", side: "r", tw: 228 },
    { text: "read_skill(“/support”)", side: "l", tw: 186, call: true },
    { text: "“And what are your policies?”", side: "r", tw: 222 },
    { text: "read_skill(“/policies”)", side: "l", tw: 194, call: true },
  ];

  /* Where the conversation starts inside the window — far enough below the
     label that the label reads as the window's, not the first bubble's. */
  const SYS_Y = 64;
  let cursor = SYS_Y;
  const LAID = TURNS.map((turn) => {
    const height = turn.call ? 20 : 34;
    const placed = { ...turn, y: cursor, height, w: turn.call ? turn.tw : turn.tw + PAD };
    cursor += height + 8;
    return placed;
  });
  const BLOCK_Y = cursor + 8;
  const BLOCK_H = 168;

  /**
   * BOTH ENDS OF A WIRE ANCHOR TO SOMETHING REAL.
   *
   * These used to stop at `FRAME_X + FRAME_W + 10` — ten pixels OUTSIDE the
   * window, touching nothing, so they read as two lines trailing off into the
   * gap rather than as a connection. A connector that lands in empty space is
   * worse than no connector: it invites the eye to look for the thing it is
   * pointing at.
   *
   * So the right end is the card's own left edge at its vertical centre, and
   * the left end is the centre of the bar group that skill BECOMES, on the
   * context block's right edge. Crossing the window border on the way in is
   * the point — the skill comes from outside the request and lands inside it.
   * Every number below is derived from the geometry it attaches to, so moving
   * a card or a bar group moves its wire with it.
   */
  const SRC_A_TOP = 44;
  const SRC_A_H = 112;
  const SRC_B_TOP = 188;
  const SRC_B_H = 148;
  const SRC_A_Y = SRC_A_TOP + SRC_A_H / 2;
  const SRC_B_Y = SRC_B_TOP + SRC_B_H / 2;
  /* Centre of each bar group: first bar's y, plus half of (rows - 1) steps of
     14, plus half the 5px bar height. */
  const BAR_A_Y = BLOCK_Y + 46 + 14 + 2.5;
  const BAR_B_Y = BLOCK_Y + 94 + 7 + 2.5;
  /* Horizontal-out, horizontal-in: the wire leaves the card and meets the bar
     level, so neither end reads as an arbitrary angle. */
  const wire = (fromY: number, toY: number) =>
    `M ${RIGHT} ${fromY} C ${RIGHT - GAP * 0.4} ${fromY}, ${INNER_R + GAP * 0.4} ${toY}, ${INNER_R} ${toY}`;
  /* Centred on the CLEAR span, and vertically between the two wires: at this
     x the upper one is at 208 and the lower at 310, so 259 clears both by
     about forty units. */
  const LABEL_X = (FRAME_R + RIGHT) / 2;
  const LABEL_Y = 259;
  const FRAME_H = BLOCK_Y + BLOCK_H + PADDING - 14;

  return (
    <Slide title="Skills to dialogs">
      <figure className="figure">
        <svg
          className="drawing"
          /* Height follows the frame rather than a fixed number: a constant
             one leaves the removed system-prompt row behind as dead space and
             pushes the whole figure off centre. */
          viewBox={`0 0 ${RIGHT + CARD_W + FRAME_X} ${FRAME_H + 28}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="One request to the model, shown as a single window: the conversation so far, then a single compiled context block at the end holding every loaded skill flattened into text with its tools. That last block is rebuilt on every turn; the skills at the right are what it is assembled from."
        >
          <defs>
            <filter id="wire-lift" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#0f0f0e" floodOpacity="0.06" />
              <feDropShadow dx="0" dy="9" stdDeviation="13" floodColor="#0f0f0e" floodOpacity="0.08" />
            </filter>
          </defs>

          {/* The window itself. */}
          <rect className="win" x={FRAME_X} y={14} width={FRAME_W} height={FRAME_H} rx={18} />
          <text className="win-label" x={INNER} y={40}>
            one request to the model
          </text>

          {LAID.map((turn) => {
            const x = turn.side === "l" ? INNER : INNER_R - turn.w;
            const baseline = turn.y + turn.height / 2 + (turn.call ? 4.6 : 6);
            if (turn.call) {
              return (
                <text className="turn-call" key={turn.text} x={INNER + INSET} y={baseline}>
                  {turn.text}
                </text>
              );
            }
            return (
              <g key={turn.text}>
                <rect
                  className={turn.side === "l" ? "turn-bubble turn-bubble--agent" : "turn-bubble"}
                  x={x}
                  y={turn.y}
                  width={turn.w}
                  height={turn.height}
                  rx={13}
                />
                <text className="turn-text" x={x + INSET} y={baseline}>
                  {turn.text}
                </text>
              </g>
            );
          })}

          {/* The only thing in the window that rises. */}
          <rect
            className="ctx-card"
            x={INNER}
            y={BLOCK_Y}
            width={INNER_R - INNER}
            height={BLOCK_H}
            rx={14}
            filter="url(#wire-lift)"
          />
          <text className="ctx-label" x={INNER + INSET} y={BLOCK_Y + 28}>
            the compiled context, rebuilt every turn
          </text>
          {bars(INNER + INSET, BLOCK_Y + 46, [244, 194, 258], "prose prose--a")}
          {bars(INNER + INSET, BLOCK_Y + 94, [222, 180], "prose prose--b")}
          {(["a", "b", "b"] as const).map((tone, i) =>
            tool(INNER + INSET + i * 26, BLOCK_Y + 118, 18, tone, `blk-${i}`),
          )}
          <text className="ctx-index" x={INNER + INSET} y={BLOCK_Y + 158}>
            loaded_skills: Support, Policies
          </text>

          <path className="wire-edge" d={wire(SRC_A_Y, BAR_A_Y)} />
          <rect className="src-card" x={RIGHT} y={SRC_A_TOP} width={CARD_W} height={SRC_A_H} rx={14} />
          <text className="src-name" x={RIGHT + 24} y={76} >
            support
          </text>
          {bars(RIGHT + 24, 94, [320, 252], "prose prose--a")}
          {tool(RIGHT + 24, 118, 22, "a", "src-a")}

          <path className="wire-edge" d={wire(SRC_B_Y, BAR_B_Y)} />
          <rect className="src-card" x={RIGHT} y={SRC_B_TOP} width={CARD_W} height={SRC_B_H} rx={14} />
          <text className="src-name" x={RIGHT + 24} y={220}>
            policies
          </text>
          {bars(RIGHT + 24, 238, [320, 260], "prose prose--b")}
          {[308, 244].map((w, i) => (
            <rect className="prose-cut" key={w} x={RIGHT + 24} y={268 + i * 14} width={w} height={5} rx={2.5} />
          ))}
          {tool(RIGHT + 24, 296, 22, "b", "src-b0")}
          {tool(RIGHT + 54, 296, 22, "b", "src-b1")}
          <text className="src-note" x={RIGHT + 88} y={311}>
            two lines held back by a condition
          </text>

          {/* What the wires actually DO. Without it the pair reads as "these
              two things are related somehow"; the whole claim of the slide is
              that a skill is turned into text and tools, and the edge is where
              that happens. */}
          <text className="wire-edge-label" x={LABEL_X} y={LABEL_Y} textAnchor="middle">
            rendered into text + tools
          </text>
        </svg>
      </figure>
    </Slide>
  );
}

/**
 * THE SAME SKILL, AS SOURCE AND AS TEXT.
 *
 * WHY THIS EXISTS. The turn slide claims a skill is "rendered into text +
 * tools" and
 * draws that as bars in a box. Fine as a picture, but the room asked to see it
 * actually happen — so this is the real file from the code slide beside the
 * real lines it compiles to.
 *
 * THE RIGHT-HAND SIDE IS THE FORMAT, NOT A PARAPHRASE. `flattenContext` emits
 * `active_skill:`, then instructions, then content, then `available_skill:`,
 * then tools, and `toolSignature` prints `name(field*) [scope]` with a star on
 * the required ones. Reproduced exactly, because the one thing a slide like
 * this cannot afford is to be approximately right about its own output.
 *
 * THE POINT IS WHAT IS MISSING. Same file, same render, and
 * `cancel_appointment` is absent because the appointment is inside the
 * twenty-four hour window. Nothing filters it out of a list downstream; it was
 * never compiled. The state is printed above the pair so the absence can be
 * traced rather than taken on faith.
 */
export function RenderCode() {
  /**
   * ONE GRID, NOT TWO PANELS. Each row holds the source on the left and the
   * line it compiles to on the right, so they sit level and the eye can trace
   * one to the other. Two independently laid-out boxes cannot do that: their
   * rows drift apart the moment either side wraps, and the reader is left
   * matching them up by hand.
   *
   * The `-` and `+` are curb's own doing. runtime.ts diffs the flattened
   * context before and after a tool call and hands the added and removed lines
   * back WITH the tool result, so the model sees what its call changed.
   */
  const ROWS = [
    {
      code: `export default function Account() {
  const [verified, setVerified] = useState(false);`,
      out: [{ mark: " ", text: "active_skill: Account" }],
    },
    {
      code: `  <Instruction>Help the caller with their account.</Instruction>`,
      out: [{ mark: " ", text: "instruction: Help the caller with their account." }],
    },
    {
      code: `  {!verified && (
    <Tool name="verify_caller" schema={z.object({ pin: z.string() })} />
  )}`,
      out: [{ mark: "-", text: "tool: verify_caller(pin*) [page]" }],
    },
    {
      code: `  {verified && (
    <Text>Balance 248.50 EUR, last payment 3 March.</Text>`,
      out: [{ mark: "+", text: "content: Balance 248.50 EUR, last payment 3 March." }],
    },
    {
      code: `    <Tool name="change_address" />
  )}`,
      out: [{ mark: "+", text: "tool: change_address() [page]" }],
    },
  ];

  return (
    <Slide title="The code, and the text it becomes">
      <div className="render-page">
        <div className="render-state">
          <span>verified: false → true</span>
        </div>

        <div className="align-card">
          <div className="align-grid">
            <p className="align-head">src/agent/account/skill.tsx</p>
            <p className="align-head">what the model reads</p>

            {ROWS.map((row) => (
              <Fragment key={row.code}>
                <div className="align-code">
                  <Code code={row.code} lang="tsx" />
                </div>
                <ul className="align-out">
                  {row.out.map((line) => (
                    <li
                      className={
                        line.mark === "+"
                          ? "diff-line diff-line--add"
                          : line.mark === "-"
                            ? "diff-line diff-line--del"
                            : "diff-line"
                      }
                      key={line.text}
                    >
                      <span className="diff-mark">{line.mark}</span>
                      {line.text}
                    </li>
                  ))}
                </ul>
              </Fragment>
            ))}
          </div>
        </div>

        <p className="render-missing">
          The balance was never filtered out before the PIN check — it was never rendered,
          so it was never in the context to leak.
        </p>
      </div>
    </Slide>
  );
}

/**
 * THE CLOSE.
 *
 * NO ASK ON THE SLIDE. The next step gets asked for out loud, across a table,
 * where a yes can actually happen. Printing it here only lets the room read it
 * and move on.
 *
 * WHAT THE SLIDE OWES INSTEAD is the answer to the question open source always
 * raises once procurement is in the room: who is on the hook when it breaks.
 * That answer is the hosting platform, and the bars say honestly how far along
 * it is.
 *
 * THE INVITATION IS A FACT, NOT AN ASK. The middle term says the decisions are
 * still open and stops there; a prospect who wants influence works out the
 * rest, and a conclusion he reaches is worth more than one handed to him.
 * It briefly read "with the first teams on it", which was an overclaim of
 * exactly the kind this deck refuses to make about competitors: nobody is on
 * the platform yet and it is not live.
 *
 * THE TENSE IS DELIBERATE. The platform is in build and the bar says so. Writing it as shipped would be the one overclaim on a deck that has had
 * every competitor claim checked against a primary source, and that is the
 * kind of thing that costs a relationship in month three rather than in the
 * meeting. Said plainly it is not a weakness anyway: a platform still being
 * decided is one a prospect can end up inside.
 */
export function Enterprise() {
  /**
   * WHERE THE TWO THINGS ACTUALLY ARE. The fill is relative distance, not a
   * measurement, and no number is printed: a percentage on a slide invites
   * "why seventy-eight" and there is no answer to that worth giving in a
   * meeting. The words carry the state and the bar carries the comparison.
   */
  const PROGRESS = [
    { name: "curb.js, the framework", state: "working today, pre-release", done: 0.78 },
    { name: "The hosting platform", state: "in build", done: 0.55 },
  ];

  const TERMS = [
    { title: "Hosted by KugelAudio", detail: "your repo deploys, we operate and scale it" },
    // The invitation, and the only honest form of it: state that the decisions
    // are open and let the conclusion be his. It rode on the platform bar as
    // "with the first teams on it" until that turned out to claim users the
    // platform does not have yet.
    { title: "Still being decided", detail: "what goes in, and how it works, is being chosen now" },
  ];

  return (
    <Slide
      display
      title={
        <>
          You write the agent.
          <br />
          We run it.
        </>
      }
    >
      <div className="progress">
        {PROGRESS.map((item) => (
          <section key={item.name}>
            <div className="progress-head">
              <h2>{item.name}</h2>
              <p>{item.state}</p>
            </div>
            <div className="track">
              <span style={{ width: `${item.done * 100}%` }} />
            </div>
          </section>
        ))}
      </div>

      <div className="terms terms--pair">
        {TERMS.map((term) => (
          <section key={term.title}>
            <h2>{term.title}</h2>
            <p>{term.detail}</p>
          </section>
        ))}
      </div>
    </Slide>
  );
}
