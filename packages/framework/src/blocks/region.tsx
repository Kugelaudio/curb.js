import type { ReactNode } from "react";
import type { SiteElementProps } from "../types.js";

/**
 * A named part of a pattern block: a procedure's step, its completed outcome,
 * anything a block needs to keep structured on its way to the compiler.
 *
 * This exists so a block never declares its own intrinsic elements. Before it,
 * every block augmented React's GLOBAL `JSX.IntrinsicElements` with one tag per
 * internal part (`agent-procedure-step`, `agent-procedure-completed`, …), which
 * meant the JSX namespace grew with each new block and a block outside this
 * package could not express structure at all. One shared element covers the
 * whole need: `name` identifies the part, any other props ride along as data,
 * and the block reads them back through `api.regions(node)`.
 */
type RegionElementProps = SiteElementProps & {
  name: string;
  [key: string]: unknown;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "agent-region": RegionElementProps;
    }
  }
}

export type RegionProps = {
  /** The block-defined part name the block's compiler switches on. */
  name: string;
  children?: ReactNode;
  /** Block-specific data (a step's order, status, title, …). */
  [key: string]: unknown;
};

export function Region({ name, children, ...data }: RegionProps) {
  return (
    <agent-region name={name} {...data}>
      {children}
    </agent-region>
  );
}
