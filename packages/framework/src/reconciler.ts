import React from "react";
import Reconciler from "react-reconciler";
import {
  ConcurrentRoot,
  ContinuousEventPriority,
  DefaultEventPriority,
  DiscreteEventPriority,
} from "react-reconciler/constants.js";
import type { HostContainer, SemanticNode } from "./types.js";

const NO_CONTEXT = {};
const NO_EVENT_PRIORITY = 0;

let currentUpdatePriority = NO_EVENT_PRIORITY;
let nextNodeId = 1;

function createNode(type: string, props: Record<string, unknown>): SemanticNode {
  return {
    id: `node-${nextNodeId++}`,
    type,
    props: cleanProps(props),
    children: [],
  };
}

function cleanProps(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref") continue;
    result[key] = value;
  }

  return result;
}

function appendChild(parent: SemanticNode, child: SemanticNode) {
  removeIfPresent(parent.children, child);
  parent.children.push(child);
}

function removeIfPresent(children: SemanticNode[], child: SemanticNode) {
  const existingIndex = children.indexOf(child);
  if (existingIndex >= 0) children.splice(existingIndex, 1);
}

const reconciler = Reconciler({
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,

  createInstance: (type: string, props: Record<string, unknown>) => createNode(type, props),
  createTextInstance: (value: string) => createNode("agent-text-node", { value }),

  appendInitialChild: appendChild,
  appendChild,
  appendChildToContainer: (container: HostContainer, child: SemanticNode) => {
    container.root = child;
    container.version += 1;
  },
  insertBefore: (parent: SemanticNode, child: SemanticNode, beforeChild: SemanticNode) => {
    removeIfPresent(parent.children, child);
    const index = parent.children.indexOf(beforeChild);
    parent.children.splice(index >= 0 ? index : parent.children.length, 0, child);
  },
  removeChild: (parent: SemanticNode, child: SemanticNode) => removeIfPresent(parent.children, child),
  removeChildFromContainer: (container: HostContainer, child: SemanticNode) => {
    if (container.root === child) container.root = null;
    container.version += 1;
  },

  commitUpdate: (
    instance: SemanticNode,
    _type: string,
    _prevProps: Record<string, unknown>,
    nextProps: Record<string, unknown>,
  ) => {
    instance.props = cleanProps(nextProps);
  },
  commitTextUpdate: (instance: SemanticNode, _oldValue: string, value: string) => {
    instance.props = { value };
  },

  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getPublicInstance: (instance: SemanticNode) => instance,
  getRootHostContext: () => NO_CONTEXT,
  getChildHostContext: () => NO_CONTEXT,
  prepareForCommit: () => null,
  resetAfterCommit: (container: HostContainer) => {
    container.version += 1;
  },
  clearContainer: (container: HostContainer) => {
    container.root = null;
    container.version += 1;
  },

  preparePortalMount() {},
  detachDeletedInstance() {},
  hideInstance() {},
  unhideInstance() {},
  hideTextInstance() {},
  unhideTextInstance() {},
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  getInstanceFromNode: () => null,

  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent() {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1,
  requestPostPaintCallback() {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: React.createContext(null),
  setCurrentUpdatePriority(newPriority: number) {
    currentUpdatePriority = newPriority;
  },
  getCurrentUpdatePriority() {
    return currentUpdatePriority;
  },
  resolveUpdatePriority() {
    if (currentUpdatePriority !== NO_EVENT_PRIORITY) return currentUpdatePriority;

    switch (typeof window !== "undefined" && window.event?.type) {
      case "click":
      case "contextmenu":
      case "dblclick":
      case "pointercancel":
      case "pointerdown":
      case "pointerup":
        return DiscreteEventPriority;
      case "pointermove":
      case "pointerout":
      case "pointerover":
      case "pointerenter":
      case "pointerleave":
      case "wheel":
        return ContinuousEventPriority;
      default:
        return DefaultEventPriority;
    }
  },
  resetFormInstance() {},
} as any);

function logRecoverableError(error: unknown) {
  console.error(error);
}

/** React's component stack for an error that escaped a render ("at Skill (file:line:col)" per
 * component, innermost first), kept with the error it describes. */
const componentStacks = new WeakMap<object, string>();

/** The component stack React reported when `error` escaped a render of a semantic root. */
export function renderComponentStack(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? componentStacks.get(error) : undefined;
}

export type SemanticRoot = {
  container: HostContainer;
  /** Render synchronously. Throws the error a component threw when no error boundary
   * caught it (React has then unmounted the tree). */
  render(element: React.ReactNode): void;
};

export function createSemanticRoot(): SemanticRoot {
  const container: HostContainer = { root: null, version: 0 };
  // React reports an error no boundary caught here and unmounts the tree; it does not
  // throw it. `render` throws it instead, so the caller fails with the component's own
  // error rather than with the empty tree it leaves behind. Throwing in this callback
  // would not reach the caller: React rethrows it from a timer.
  let uncaught: { error: unknown } | null = null;
  const onUncaughtError = (error: unknown, info?: { componentStack?: string }) => {
    logRecoverableError(error);
    if (typeof error === "object" && error !== null && info?.componentStack) {
      componentStacks.set(error, info.componentStack);
    }
    uncaught ??= { error };
  };
  const root = (reconciler as any).createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    onUncaughtError,
    logRecoverableError,
    logRecoverableError,
    null,
  );

  return {
    container,
    render(element: React.ReactNode) {
      uncaught = null;
      (reconciler as any).updateContainerSync(element, root, null, undefined);
      (reconciler as any).flushSyncWork();
      const failure = uncaught as { error: unknown } | null;
      uncaught = null;
      if (failure) throw failure.error;
    },
  };
}
