/**
 * What a skill is made of, in one still illustration.
 *
 * NOTHING MOVES. A scrubbing, looping version of this existed and answered the
 * wrong question: it explained a RUN — one skill loading, then another — when
 * what a customer needs first is what a skill IS. Anatomy can be read at
 * whatever pace the person talking over it needs, and it survives being paused
 * on a slide.
 *
 * A CONDITION UNLOCKS THINGS. This is the part that took the longest to get
 * right. It was drawn as a fork, then a decision diamond, then a line of JSX,
 * then a single dashed tool — each clearer than the last, and all of them
 * understating it. A condition in curb does not just gate a function: it can
 * withhold whole instructions and the LINK to another skill, which means it
 * decides what the agent can even see next. So the conditional part is drawn as
 * a region holding all three, headed by a plain sentence saying when it opens.
 *
 * LINKS ARE IN THE TEXT. A skill reaches another the way any markdown does — a
 * link inside the prose — so the connectors leave the run of text that names
 * the target, not the border of the card. Drawing them from the border said
 * "these two are associated"; drawing them from the sentence says the sentence
 * is the connection, which is what is actually true.
 */

import { Wordmark } from "./wordmark.js";

/** The opened skill. Everything else is positioned against it. */
const CARD = { x: 352, y: 80, w: 384, h: 412 };

/**
 * What it points at. SPECIALISATIONS of the parent, not neighbours: `claims`
 * pointing at `coverage` and `billing` was a relationship nobody could justify,
 * and on a slide that reads as boxes wired together to make a picture. Once the
 * caller is filing a claim, the kind of claim is the next thing that matters.
 */
const LINKED = [
  // Vertically centred on the connector that reaches them, so the curves run
  // short and level instead of sweeping across empty space.
  { name: "water damage", y: 130, tools: 3, conditional: false },
  // Gated on `claim.isOpen`, so it has to be something that only MAKES SENSE
  // once a claim exists. `theft` failed that: a kind of claim is what you pick
  // before opening one, so hiding it behind an open claim inverted the flow.
  // Assessing damage is downstream of the claim by definition.
  { name: "damage assessment", y: 326, tools: 2, conditional: true },
];
const LINK = { x: 872, w: 232, h: 128 };

/** Always-on instructions. One line carries the link to the first skill. */
const PROSE = [
  { width: 300, link: null },
  { width: 146, link: { width: 118, target: 0 } },
  { width: 268, link: null },
];

/** Inside the conditional region: more instructions, and a link that does not
 * exist until the condition holds. */
const UNLOCKED = [
  { width: 196, link: null },
  { width: 96, link: { width: 104, target: 1 } },
];

const LINE_GAP = 22;
const PROSE_TOP = CARD.y + 96;
const TOOLS_Y = CARD.y + 176;
/**
 * The conditional region, laid out as a stack: the sentence, then the
 * instructions it unlocks, then the tool. These were overlapping — the tool was
 * placed from the gate's top while the lines were placed from their own origin,
 * so the two collided as soon as a second line existed. Every offset here is
 * measured from GATE.y for that reason.
 */
const GATE = { y: CARD.y + 236, h: 156 };
const GATE_TOP = GATE.y + 54;
const GATE_TOOL_Y = GATE.y + 98;

/** Each callout points at the middle of the part it names, not near it. */
const PARTS = [
  { at: 198, label: "instructions", note: "markdown the model reads" },
  { at: 280, label: "tools", note: "functions it can call" },
  { at: 352, label: "conditions", note: "on state your tools set" },
];

const LABEL_X = 250;

/** A run of prose, with an optional link in it. */
function Line({
  x,
  y,
  width,
  link,
  dim,
}: {
  x: number;
  y: number;
  width: number;
  link: { width: number; target: number } | null;
  dim?: boolean;
}) {
  const linkX = x + width + 14;
  return (
    <>
      <rect
        className={dim ? "prose prose--dim" : "prose"}
        x={x}
        y={y}
        width={width}
        height={5}
        rx={2.5}
      />
      {link ? (
        <>
          <rect
            className={dim ? "prose-link prose-link--dim" : "prose-link"}
            x={linkX}
            y={y}
            width={link.width}
            height={5}
            rx={2.5}
          />
          <line
            className={dim ? "prose-underline prose-underline--dim" : "prose-underline"}
            x1={linkX}
            y1={y + 11}
            x2={linkX + link.width}
            y2={y + 11}
          />
        </>
      ) : null}
    </>
  );
}

/** Where a link's connector starts: the end of the run of text that names it. */
function linkEnd(lines: typeof PROSE, top: number, target: number) {
  const index = lines.findIndex((line) => line.link?.target === target);
  const line = lines[index]!;
  return {
    x: CARD.x + 30 + line.width + 14 + line.link!.width,
    y: top + index * LINE_GAP + 2.5,
  };
}

export function Concepts() {
  return (
    <main className="page concepts-page">
      <header className="lede">
        {/* Same mark as the positioning view, so the two read as one deck.
            The subject gets a headline of its own rather than being demoted to
            a note beside the product name. */}
        <Wordmark />
        <h1 className="headline">Skills</h1>
      </header>

      <figure className="figure">
        <svg
          className="drawing"
          viewBox="0 0 1240 512"
          role="img"
          aria-label="A skill is one file holding instructions and the tools it can call. A condition can withhold further instructions, another tool, and the link to a follow-on skill, so it decides what the agent can see next. Links to other skills are written inline in the text."
        >
          <g className="anatomy">
            {PARTS.map((part) => (
              <g key={part.label}>
                <text className="part-label" x={LABEL_X} y={part.at} textAnchor="end">
                  {part.label}
                </text>
                <text className="part-note" x={LABEL_X} y={part.at + 20} textAnchor="end">
                  {part.note}
                </text>
                <line
                  className="leader"
                  x1={LABEL_X + 18}
                  y1={part.at - 5}
                  x2={CARD.x - 12}
                  y2={part.at - 5}
                />
              </g>
            ))}

            {/* THE SKILL. One outline around every part, because it is one file
                — separate boxes would invent a boundary the format lacks. */}
            <rect className="card" x={CARD.x} y={CARD.y} width={CARD.w} height={CARD.h} rx={18} />
            {/* The domain, quietly, after the name — it says what kind of agent
                this skill belongs to without competing with the skill itself. */}
            <text className="card-title" x={CARD.x + 30} y={CARD.y + 48}>
              claims
              <tspan className="card-domain" dx={12}>
                insurance
              </tspan>
            </text>

            {PROSE.map((line, index) => (
              <Line
                key={index}
                x={CARD.x + 30}
                y={PROSE_TOP + index * LINE_GAP}
                width={line.width}
                link={line.link}
              />
            ))}

            {[0, 1].map((index) => (
              <g key={index} transform={`translate(${CARD.x + 30 + index * 52} ${TOOLS_Y})`}>
                <rect className="tool-box" width={40} height={40} rx={11} />
                <g transform="translate(9 9) scale(0.92)">
                  <path
                    className="tool-mark"
                    d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                  />
                </g>
              </g>
            ))}

            {/* THE CONDITIONAL REGION. Everything inside it is withheld until
                the sentence at its head is true — including the link, which is
                why a condition decides what the agent can reach next and not
                merely what it can do now. */}
            <rect
              className="gate"
              x={CARD.x + 18}
              y={GATE.y}
              width={CARD.w - 36}
              height={GATE.h}
              rx={12}
            />
            {/* HALF PROSE, HALF EXPRESSION. Pure JSX was unreadable to anyone
                who does not write React; pure English hid that this is a real
                condition on real state. Keeping "only when" in plain words and
                the value in code says both: it is a rule, and it is evaluated
                against something the tools set. */}
            <text className="condition" x={CARD.x + 34} y={GATE.y + 30}>
              only when{" "}
              <tspan className="condition-expr">claim.isOpen</tspan>
            </text>

            {UNLOCKED.map((line, index) => (
              <Line
                key={index}
                x={CARD.x + 30}
                y={GATE_TOP + index * LINE_GAP}
                width={line.width}
                link={line.link}
                dim
              />
            ))}

            <g transform={`translate(${CARD.x + 30} ${GATE_TOOL_Y})`}>
              <rect className="tool-box tool-box--dim" width={32} height={32} rx={9} />
              <g transform="translate(7 7) scale(0.76)">
                <path
                  className="tool-mark tool-mark--dim"
                  d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                />
              </g>
            </g>

            {/* Connectors leave the LINK, not the card. Held flat until clear of
                the border so they never cut across the parts below. */}
            {LINKED.map((entry, index) => {
              const source = entry.conditional
                ? linkEnd(UNLOCKED, GATE_TOP, index)
                : linkEnd(PROSE, PROSE_TOP, index);
              const to = entry.y + LINK.h / 2;
              return (
                <g key={entry.name}>
                  <path
                    className={entry.conditional ? "edge edge--dim" : "edge"}
                    d={`M ${source.x} ${source.y} C ${CARD.x + CARD.w + 30} ${source.y}, ${LINK.x - 70} ${to}, ${LINK.x - 6} ${to}`}
                  />
                  <rect
                    className={entry.conditional ? "linked linked--dim" : "linked"}
                    x={LINK.x}
                    y={entry.y}
                    width={LINK.w}
                    height={LINK.h}
                    rx={14}
                  />
                  <text
                    className={entry.conditional ? "linked-title linked-title--dim" : "linked-title"}
                    x={LINK.x + 22}
                    y={entry.y + 32}
                  >
                    {entry.name}
                  </text>
                  {[160, 120].map((width, line) => (
                    <rect
                      className={entry.conditional ? "prose prose--dim" : "prose"}
                      key={line}
                      x={LINK.x + 22}
                      y={entry.y + 48 + line * 14}
                      width={width}
                      height={4}
                      rx={2}
                    />
                  ))}
                  {Array.from({ length: entry.tools }, (_, tool) => (
                    <rect
                      className={
                        entry.conditional
                          ? "tool-box tool-box--small tool-box--dim"
                          : "tool-box tool-box--small"
                      }
                      key={tool}
                      x={LINK.x + 22 + tool * 30}
                      y={entry.y + 84}
                      width={24}
                      height={24}
                      rx={7}
                    />
                  ))}
                </g>
              );
            })}

            <text className="part-label" x={LINK.x} y={54}>
              links to other skills
            </text>
            <text className="part-note" x={LINK.x} y={74}>
              written inline in the text, so a condition can withhold one
            </text>
          </g>
        </svg>
      </figure>
    </main>
  );
}
