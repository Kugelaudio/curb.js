import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Overview } from "./Overview.js";
import { Concepts } from "./Concepts.js";
import {
  PainPoints,
  OpenSource,
  AgainstElevenLabs,
  CodeCompare,
  TurnLoop,
  TurnTaking,
  RenderCode,
  Enterprise,
} from "./slides.js";

/**
 * The deck, in the order it is pitched.
 *
 * WARM FIRST, TECHNICAL SECOND. The order is the argument: name the prospect's
 * own pain back to them, get agreement, and only then show what the framework
 * does about it. A previous meeting spent seventeen of twenty minutes on
 * framework detail and landed nothing, which is what this ordering exists to
 * avoid. Everything from `concepts` on is skippable if the meeting runs short:
 * recap, positioning, open source, the table and the code comparison carry the
 * pitch on their own.
 *
 * A "One place. No second server." slide used to sit here, making the
 * single-deploy argument with four labelled boxes against one. The code
 * comparison makes the same point with real files, so the abstract version was
 * a slide the room had to sit through twice.
 */
const SLIDES: Array<{ id: string; title: string; render: () => ReactNode }> = [
  { id: "pain", title: "Recap", render: () => <PainPoints /> },
  { id: "", title: "What curb.js is", render: () => <Overview /> },
  { id: "open-source", title: "Open source", render: () => <OpenSource /> },
  { id: "compare", title: "Where we differ", render: () => <AgainstElevenLabs /> },
  { id: "code", title: "Rules the agent cannot break", render: () => <CodeCompare /> },
  { id: "concepts", title: "Skills", render: () => <Concepts /> },
  { id: "turns", title: "How a skill becomes context", render: () => <TurnLoop /> },
  { id: "wire", title: "Skills to dialogs", render: () => <TurnTaking /> },
  { id: "render", title: "The code, and the text it becomes", render: () => <RenderCode /> },
  { id: "enterprise", title: "Enterprise", render: () => <Enterprise /> },
];

function slideIndex(hash: string): number {
  const id = hash.replace(/^#/, "");
  const found = SLIDES.findIndex((slide) => slide.id === id);
  return found === -1 ? 0 : found;
}

/**
 * EXPORT MODE. `#export` stacks every slide at a fixed 1600x900 with a page
 * break after each, so the browser's own "Save as PDF" produces a 16:9 deck
 * that imports straight into Keynote or Google Slides.
 *
 * Printing rather than screenshotting is deliberate: the type stays vector, so
 * the deck survives a projector at any resolution, and it needs no tooling
 * installed on the machine doing the presenting.
 *
 * Viewport units resolve against the PAGE BOX under print media, which is why
 * the stacked view can look wrong on screen and still export correctly. This
 * route is a staging page, not a second way to read the deck.
 */
function isExporting(hash: string): boolean {
  return hash.replace(/^#/, "") === "export";
}

export function Deck() {
  const [index, setIndex] = useState(() => slideIndex(window.location.hash));
  const [exporting, setExporting] = useState(() => isExporting(window.location.hash));

  useEffect(() => {
    const onHash = () => {
      setIndex(slideIndex(window.location.hash));
      setExporting(isExporting(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /**
   * FIT THE SLIDE TO THE WINDOW, DO NOT RESHAPE IT.
   *
   * Every slide is authored against one 1600x900 box, which is also what
   * `#export` prints. Letting the live route reflow to the window instead
   * meant the deck being rehearsed was not the deck being shown: on a wide
   * screen the code slide's columns stretched by two thirds and its content
   * floated in the middle of an over-tall track.
   *
   * CSS cannot divide a length by a length to get a scale factor portably, so
   * the ratio is computed here and handed to the stylesheet as a custom
   * property.
   */
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (exporting) return;
    const fit = () => setScale(Math.min(window.innerWidth / 1600, window.innerHeight / 900));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [exporting]);

  // Arrow keys, because this is presented from a laptop and clicking a URL bar
  // mid-sentence is not a thing anyone should have to do.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const forward = event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ";
      const back = event.key === "ArrowLeft" || event.key === "PageUp";
      if (!forward && !back) return;
      event.preventDefault();
      const next = Math.min(SLIDES.length - 1, Math.max(0, index + (forward ? 1 : -1)));
      window.location.hash = SLIDES[next]!.id;
      setIndex(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index]);

  if (exporting) {
    return (
      <div className="export">
        {SLIDES.map((slide) => (
          <div className="export-slide" key={slide.id || "overview"}>
            {slide.render()}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="stage-fit">
      <div className="slide-stage" style={{ "--stage-scale": scale } as CSSProperties}>
        {SLIDES[index]!.render()}
      </div>
      {/* Outside the stage on purpose: it is a presenter aid, not part of the
          slide, so it should not shrink with the projection. */}
      <p className="deck-position" aria-hidden="true">
        {index + 1} / {SLIDES.length}
      </p>
    </div>
  );
}
