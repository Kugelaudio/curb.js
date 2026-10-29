import { formatAuthoringDiagnostic } from "../authoring.js";
import { listPublicMarkdown } from "../public-context.js";

/**
 * The artifact's own answer to "can this agent render what it was built with".
 *
 * This module runs INSIDE the artifact, not in the build. `verify.ts` proves a worker
 * starts, which is a property of the module graph resolving; it says nothing about the
 * agent having any content. A build once shipped an artifact whose worker booted, joined
 * a room, and rendered an empty tree because the project's `context/` markdown was never
 * packaged — a healthy-looking runner with nothing to say.
 *
 * The check renders the COMPLETE authoring surface (every skill, the way `curb check`
 * does), because file-backed markdown usually lives in skills a conversation opens
 * only when needed.
 */

/** argv token that switches the generated worker from "run" to "self-check". */
export const RENDER_CHECK_ARG = "curb-render-check";

/** Prefix of the single line this check prints. The report is the rest of the line. */
export const RENDER_CHECK_MARKER = "curb-render-check";

export type RenderCheckReport = {
  /** Every skill route that rendered. */
  skills: string[];
  /** Markdown the artifact carries, by `<Text src>` key. */
  contextFiles: string[];
  /** Which skill rendered which markdown file, and how much text reached the model
   * context. `chars: 0` is impossible — the compiler drops empty docs — so a doc listed
   * here is content the agent can actually say. */
  contextDocs: { skill: string; src: string; chars: number }[];
  /** Formatted error-severity authoring diagnostics. Non-empty means failure. */
  errors: string[];
};

/**
 * Render every skill of the bundled agent and report what came out.
 *
 * Throws rather than reporting when a render fails outright: a `<Text src>` whose file is
 * missing raises out of React, and swallowing it here would replace the loud failure this
 * whole path exists to keep.
 */
export async function runHostedRenderCheck(): Promise<RenderCheckReport> {
  const { createAgentRuntime, getHostedAgent } = await import("../server/bootstrap.js");

  const hosted = await getHostedAgent();
  const skills = hosted.routes.map((route) => route.path);
  // Every skill stays resident: the check compiles each one's context, and eviction
  // would make the report depend on route order.
  const { runtime } = await createAgentRuntime(hosted.id, {
    maxLoadedSkills: Math.max(skills.length, 1),
  });

  const contextDocs: RenderCheckReport["contextDocs"] = [];
  for (const skill of skills) {
    runtime.loadSkill(skill);
    for (const block of runtime.isolatedContext(skill).blocks) {
      if (block.type === "doc") {
        contextDocs.push({ skill, src: block.src, chars: block.text.length });
      }
    }
  }

  const report: RenderCheckReport = {
    skills,
    contextFiles: listPublicMarkdown(),
    contextDocs,
    errors: hosted.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => formatAuthoringDiagnostic(diagnostic)),
  };

  // One line, machine-readable, on stdout: the build reads it back out of the child's
  // output the same way it reads the worker's start marker.
  console.log(`${RENDER_CHECK_MARKER} ${JSON.stringify(report)}`);
  return report;
}
