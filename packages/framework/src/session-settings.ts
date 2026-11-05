/**
 * The providers one conversation runs on right now: the effective `{ llm, stt, tts }`.
 *
 * Effective value per slot, highest first:
 *   1. an outside override (`update`: a client's `curb.update`, the host's
 *      `PATCH /v1/sessions/{id}`), gated by `<Agent adjustable>`; see `settings-update.ts`,
 *   2. the ACTIVE skill's `<Skill path=… tts={…}>` prop,
 *   3. the `<Agent tts={…}>` prop,
 *   4. the framework default: `kugelaudio.tts()`, `azure.stt()`, `kugelaudio.llm()`.
 *
 * An override changes one option of the provider underneath it (`tts.voice` is the voice of
 * whichever TTS the props pick) and lasts until the next outside change of the same path.
 *
 * The runtime feeds it the props after every render (`setProps`); the voice host subscribes
 * and swaps a speech provider only when its slot's descriptor really changed, compared
 * structurally, so a re-render with an unchanged prop rebuilds nothing. The LLM is read per
 * turn from `current()`.
 */

import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { azure, kugelaudio, type AgentProviderProps, type ProviderProps, type S2sDescriptor } from "./providers.js";
import {
  ADJUSTABLE_PATHS,
  applySettingsOverrides,
  effectiveSettings,
  planSettingsUpdate,
  staleTtsOverrides,
  type CredentialCheck,
  type Adjustable,
  type AdjustablePath,
  type EffectiveSettings,
  type ProviderSettings,
  type SettingsOrigin,
  type SettingsOverrides,
} from "./settings-update.js";
import type { SemanticNode } from "./types.js";

export type { ProviderSettings };

export type ProviderSlot = keyof ProviderSettings;

const SLOTS: readonly ProviderSlot[] = ["llm", "stt", "tts"];

/** What a conversation runs on when the tree sets no provider prop: today's defaults. */
export function defaultProviderSettings(): ProviderSettings {
  return { llm: kugelaudio.llm(), stt: azure.stt(), tts: kugelaudio.tts() };
}

export type SettingsListener = (settings: ProviderSettings, changed: readonly ProviderSlot[]) => void;

export interface SessionSettingsOptions {
  /** Called after an accepted `update`, once listeners ran. The runtime re-renders here. */
  onUpdated?: () => void;
  /** Debug-level notes, such as an override dropped because the provider changed. */
  debug?: (message: string) => void;
}

export class SessionSettings {
  private props: AgentProviderProps = {};
  private adjustable: Adjustable = {};
  /** The outside-change layer: one value per adjustable path. */
  private overrides: SettingsOverrides = {};
  private effective: ProviderSettings = defaultProviderSettings();
  private readonly listeners = new Set<SettingsListener>();
  private readonly onUpdated: (() => void) | undefined;
  private readonly debug: (message: string) => void;
  private credentials: CredentialCheck | undefined;

  constructor(options: SessionSettingsOptions = {}) {
    this.onUpdated = options.onUpdated;
    this.debug = options.debug ?? ((message) => console.debug(message));
  }

  /**
   * How the server tells whether a provider can run here. Set by the voice host; without it
   * a provider switch is not checked for its credential.
   */
  setCredentialCheck(check: CredentialCheck): void {
    this.credentials = check;
  }

  /** The effective providers. */
  current(): ProviderSettings {
    return this.effective;
  }

  /** The speech-to-speech model of `<Agent s2s>`, or undefined. No skill or outside change moves it. */
  s2s(): S2sDescriptor | undefined {
    return this.props.s2s;
  }

  /** The effective settings as the wire reports them (no credentials, no extra options). */
  view(): EffectiveSettings {
    return effectiveSettings(this.effective);
  }

  /** The props read from the rendered tree. Returns the slots whose effective value changed. */
  setProps(props: AgentProviderProps): readonly ProviderSlot[] {
    this.props = props;
    return this.recompute();
  }

  /** `<Agent adjustable>` as the tree renders it now. */
  setAdjustable(adjustable: Adjustable): void {
    this.adjustable = adjustable;
  }

  /**
   * Apply one outside change. Every path in `body` must be adjustable for `origin`, and
   * every value must suit the provider it changes, or the whole update is refused with
   * {@link SettingsRefusedError} and nothing changes. Returns the effective settings after it.
   */
  update(origin: SettingsOrigin, body: unknown): EffectiveSettings {
    const changes = planSettingsUpdate({
      body,
      origin,
      adjustable: this.adjustable,
      base: this.base(),
      ...(this.credentials === undefined ? {} : { credentials: this.credentials }),
    });
    this.overrides = { ...this.overrides, ...changes };
    this.recompute();
    this.onUpdated?.();
    return this.view();
  }

  /** The override layer, to carry onto the runtime that replaces this one mid-call (a rewind). */
  overridesSnapshot(): SettingsOverrides {
    return { ...this.overrides };
  }

  /** Adopt a previous runtime's override layer. Returns the slots whose effective value changed. */
  restoreOverrides(overrides: SettingsOverrides): readonly ProviderSlot[] {
    this.overrides = { ...overrides };
    return this.recompute();
  }

  /** Called with the new settings whenever at least one slot's effective value changes. */
  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** What the props (or the defaults) say, before any override. */
  private base(): ProviderSettings {
    const defaults = defaultProviderSettings();
    return {
      llm: this.props.llm ?? defaults.llm,
      stt: this.props.stt ?? defaults.stt,
      tts: this.props.tts ?? defaults.tts,
    };
  }

  private recompute(): readonly ProviderSlot[] {
    const base = this.base();
    // A voice or model set for one TTS vendor names nothing at another: when the props move
    // to another provider (a skill with its own tts), the override goes.
    for (const path of staleTtsOverrides(base, this.overrides)) {
      this.debug(
        `[curb] dropped the ${path} override set for ${this.overrides[path]?.provider}: the agent now speaks with ${base.tts.provider}.`,
      );
      const { [path]: _dropped, ...rest } = this.overrides;
      this.overrides = rest;
    }
    const next = applySettingsOverrides(base, this.overrides);
    const changed = SLOTS.filter((slot) => !sameDescriptor(this.effective[slot], next[slot]));
    if (changed.length === 0) return changed;
    // Keep unchanged slots' previous objects, so identity tracks the structural value.
    this.effective = {
      llm: changed.includes("llm") ? next.llm : this.effective.llm,
      stt: changed.includes("stt") ? next.stt : this.effective.stt,
      tts: changed.includes("tts") ? next.tts : this.effective.tts,
    };
    for (const listener of this.listeners) listener(this.effective, changed);
    return changed;
  }
}

/** Structural equality of two plain JSON values (key order does not matter). */
export function sameDescriptor(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      sameDescriptor((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

/**
 * Read the provider props from a rendered tree: `<Agent>`'s, overridden per slot by the
 * first rendered `<Skill>` link to `activePath` that sets that slot. Put the prop on the
 * link in the always-rendered `<Skills>` index, so it holds however the skill was reached.
 */
export function providerPropsFromTree(root: SemanticNode | null, activePath: string): AgentProviderProps {
  let site: SemanticNode | undefined;
  const links: SemanticNode[] = [];
  const visit = (node: SemanticNode) => {
    if (node.type === "agent-site") site ??= node;
    if (node.type === "agent-skill" && node.props.to === activePath) links.push(node);
    for (const child of node.children) visit(child);
  };
  if (root) visit(root);

  const props: AgentProviderProps = {};
  if (site?.props.s2s !== undefined) {
    assertDescriptor("s2s", site.props.s2s, "Agent");
    props.s2s = site.props.s2s as S2sDescriptor;
  }
  for (const slot of SLOTS) {
    const fromSkill = links.find((link) => link.props[slot] !== undefined);
    const value = fromSkill ? fromSkill.props[slot] : site?.props[slot];
    if (value === undefined) continue;
    assertDescriptor(slot, value, fromSkill ? `Skill path="${activePath}"` : "Agent");
    (props as Record<ProviderSlot, unknown>)[slot] = value;
  }
  return props;
}

function assertDescriptor(slot: ProviderSlot | "s2s", value: unknown, component: string): void {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === slot) return;
  throw new AgentAuthoringError({
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message: `<${component}> got ${slot}=${JSON.stringify(value)}, which is not a ${slot} provider.`,
    location: { component },
    fix:
      `Build the value with a factory from "curb/providers", e.g. ` +
      (slot === "tts"
        ? 'kugelaudio.tts({ language: "en" })'
        : slot === "stt"
          ? "azure.stt()"
          : slot === "s2s"
            ? "openai.live()"
            : "kugelaudio.llm()") +
      ".",
  });
}

/**
 * Read `<Agent adjustable>` from a rendered tree. Absent means nothing is adjustable.
 * Anything but `{ client?: path[], host?: path[] }` with known paths is an authoring error.
 */
export function adjustableFromTree(root: SemanticNode | null): Adjustable {
  let site: SemanticNode | undefined;
  const visit = (node: SemanticNode) => {
    if (node.type === "agent-site") site ??= node;
    if (site === undefined) for (const child of node.children) visit(child);
  };
  if (root) visit(root);
  const value = site?.props.adjustable;
  if (value === undefined) return {};
  const fail = (why: string): never => {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
      severity: "error",
      message: `<Agent> got adjustable=${JSON.stringify(value)}: ${why}`,
      location: { component: "Agent" },
      fix:
        'Pass the paths each side may change, e.g. adjustable={{ client: ["tts.voice"], host: ["tts.voice", "llm"] }}. ' +
        `Paths: ${ADJUSTABLE_PATHS.join(", ")}.`,
    });
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("it must be an object");
  const result: { client?: AdjustablePath[]; host?: AdjustablePath[] } = {};
  for (const [origin, paths] of Object.entries(value as Record<string, unknown>)) {
    if (origin !== "client" && origin !== "host") fail(`"${origin}" is not an origin; use client or host`);
    if (!Array.isArray(paths)) fail(`${origin} must be an array of paths`);
    for (const path of paths as unknown[]) {
      if (!ADJUSTABLE_PATHS.includes(path as AdjustablePath)) fail(`${JSON.stringify(path)} is not an adjustable path`);
    }
    result[origin as "client" | "host"] = [...(paths as AdjustablePath[])];
  }
  return result;
}
