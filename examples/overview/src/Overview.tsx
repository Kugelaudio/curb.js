/**
 * What curb.js is, in one screen.
 *
 * ONE DRAWING, NOT A LAYOUT. An earlier pass put every element in its own
 * bordered card and the page turned into a stack of boxes — which is the shape
 * of a spec sheet, not of the thing being described. Voice is a continuous
 * medium and the claim here is about flow: many sources, one channel, one
 * thing you keep. Curves say that; rectangles fight it.
 *
 * The sources deliberately mix kinds — three speech-to-speech models and one
 * cascading STT/LLM/TTS pipeline — because the framework does not distinguish
 * them. Splitting them into two labelled groups would invent a taxonomy the
 * interface does not have.
 *
 * NO COLOUR. Tinting each source was tried and it turned a calm drawing into
 * a chart; the hues implied differences between the models that the framework
 * specifically does not care about. Weight carries the hierarchy instead —
 * faint tributaries, one solid channel — which is the same argument told
 * quietly.
 *
 * Nothing moves. It has to survive being paused on a slide.
 *
 * The viewBox origin is offset rather than the coordinates being rewritten:
 * every position in here is expressed against the fan and the junction, and
 * nudging the window keeps those relationships intact.
 */

import { Wordmark } from "./wordmark.js";

/** Where each source enters on the left, top to bottom. The last one is
 * deliberately unnamed: the strongest version of "interchangeable" is a slot
 * for a model that does not exist yet. Kept short so it sits in the column as
 * one more entry rather than as a sentence among names. */
const SOURCES = [
  { y: 160, label: "Kugel Fluid" },
  { y: 235, label: "OpenAI Realtime" },
  { y: 310, label: "Gemini Live" },
  // The cascade belongs in the SAME list, not in a section of its own: to
  // everything right of the junction it is just another source, and that is
  // the whole point. Its arrows are the only thing marking it as a pipeline.
  { y: 385, label: "STT \u2192 LLM \u2192 TTS" },
  { y: 460, label: "what\u2019s next" },
];

/** The agent. No enclosing shape: a circle around the words drew a boundary
 * the drawing does not need — the channel arriving at the text already says
 * where it lands, and the outline only added a second thing to look at. */
const AGENT = { cx: 1052, cy: 310 };

/** Where the channel stops. Close enough to the agent's text that the line
 * clearly arrives AT it — a wide gap made the two read as separate things that
 * happened to share a row. */
const CHANNEL_END = 892;

const JOIN_X = 640;
const JOIN_Y = 310;

/** Where the curves leave their labels. The fan used to run 370px across a
 * 384px spread, which read as a long journey; the drawing only needs to say
 * "several arrive", and saying it in less space says it faster. */
const FAN_START = 392;

/** A tributary from `y` into the junction. The first control point holds the
 * line flat as it leaves its label, so each one reads as its own source before
 * it starts bending — a curve that turns immediately reads as one hand-drawn
 * squiggle rather than four separate inputs. */
function tributary(y: number): string {
  return `M ${FAN_START} ${y} C 504 ${y}, 553 ${JOIN_Y}, ${JOIN_X} ${JOIN_Y}`;
}

export function Overview() {
  return (
    <main className="page">
      <header className="lede">
        {/* The name carries the weight; the licence rides alongside it quietly.
            Lowercase to match every other label on the page — title case here
            would be the loudest thing on screen, which it is not. */}
        <Wordmark />
        {/* The product, at headline scale. The category moved to where the
            channel lands, so the slide reads name first and definition second
            rather than the other way round. */}
        <h1 className="headline">curb.js</h1>
      </header>

      <figure className="figure">
        <svg
          className="drawing"
          viewBox="95 120 1240 380"
          role="img"
          aria-label="Several speech-to-speech models and a cascading STT-LLM-TTS pipeline converge into a single interface, which connects to one curb.js agent: a voice AI framework."
        >
          <defs>
            {/* Opaque where each source is named, gone by the time it reaches
                the channel. Five lines converging at full weight make a blot;
                fading them turns the same convergence into something the eye
                reads as merging. */}
            <linearGradient
              id="tributary-fade"
              gradientUnits="userSpaceOnUse"
              x1={FAN_START}
              x2={JOIN_X}
            >
              <stop offset="0" stopColor="var(--ink-soft)" stopOpacity={0.55} />
              <stop offset="0.55" stopColor="var(--ink-soft)" stopOpacity={0.3} />
              <stop offset="1" stopColor="var(--ink-soft)" stopOpacity={0.06} />
            </linearGradient>

            {/* The channel picks up exactly where the tributaries fade out and
                strengthens rightward. Without this the middle source — which is
                collinear with the channel — met it at a hard shade change, and
                one continuous horizontal line that switches colour halfway
                reads as a mistake rather than as a merge. */}
            <linearGradient
              id="channel-rise"
              gradientUnits="userSpaceOnUse"
              x1={JOIN_X}
              x2={JOIN_X + 150}
            >
              <stop offset="0" stopColor="var(--ink-soft)" stopOpacity={0.06} />
              <stop offset="0.45" stopColor="var(--ink-soft)" stopOpacity={0.62} />
              <stop offset="1" stopColor="var(--ink-soft)" stopOpacity={1} />
            </linearGradient>
          </defs>

          <g className="ink">
            {SOURCES.map((source) => (
              <g key={source.label}>
                <text className="source-label" x={FAN_START - 32} y={source.y} textAnchor="end">
                  {source.label}
                </text>
                <path className="tributary" d={tributary(source.y)} />
              </g>
            ))}

            {/* The channel. NO JUNCTION DOT: the dot, the gap before it and the
                hard start of the thick line read as three separate jolts in the
                one place the drawing should feel continuous. The tributaries
                now end exactly where the channel begins and fade out as they
                arrive (see the gradient above), so the bundle dissolves into a
                single line instead of pinching into a knot. */}
            <path
              className="channel"
              d={`M ${JOIN_X} ${JOIN_Y} L ${CHANNEL_END} ${JOIN_Y}`}
            />
            <text
              className="caption"
              x={(JOIN_X + CHANNEL_END) / 2}
              y={JOIN_Y - 26}
              textAnchor="middle"
            >
              one interface
            </text>

            {/* WHAT THE CHANNEL LANDS ON. This slot used to hold the product
                name in small type over its job description in large, which put
                the name in the quiet position and the explanation in the loud
                one. The name is the headline now, so the category sits here:
                five ways of doing speech converge, and what they converge into
                is a voice AI framework.

                Two baselines, optically centred on the channel, because a
                glyph's visual centre sits above its baseline. */}
            <text className="vessel-line" x={AGENT.cx} y={296} textAnchor="middle">
              Voice AI
            </text>
            <text className="vessel-line" x={AGENT.cx} y={340} textAnchor="middle">
              Framework
            </text>
          </g>
        </svg>
      </figure>

    </main>
  );
}
