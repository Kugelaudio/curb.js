# Product

## Register

product

## Users

Engineers authoring and debugging Curb voice agents. They work locally in the
browser preview while editing React and TypeScript, and need to understand exactly
which context, skills, tools, and branches the model can use.

## Product Purpose

Curb makes a voice agent feel like a normal React application: source remains
editable, the framework compiles it into model context, and the preview makes the
result visible and testable. Success means an author can move from code to a spoken
conversation, diagnose behavior, and refine the agent without learning media-server
or orchestration internals.

## Brand Personality

Clear, calm, technical. The interface should feel trustworthy to an experienced
developer while remaining understandable to someone building their first agent.

## Anti-references

- Workflow editors that imply an LLM follows one deterministic path when it does not.
- Colorful generic SaaS canvases with decorative cards, gradients, or excessive badges.
- Dense IDE chrome that competes with the agent rather than explaining it.
- Controls whose state or effect is communicated only through color.

## Design Principles

1. Show the model's actual available context, not an inferred idealization.
2. Distinguish static possibilities from the state active in this conversation.
3. Keep source concepts recognizable in the UI: skill, tool, condition, and context.
4. Make every inspection surface navigable back to the authored skill.
5. Prefer one clear interaction path with details available on demand.

## Accessibility & Inclusion

Target WCAG 2.1 AA. All controls and graph navigation must work by keyboard, expose
semantic labels, preserve visible focus, and avoid color-only state. Motion must
respect `prefers-reduced-motion`, and text contrast must meet AA requirements.
