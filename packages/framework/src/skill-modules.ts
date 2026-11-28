/**
 * Which route each skill module was discovered at, so a test can name a skill by its module
 * (`import * as Refund from "./refund/skill.js"`) where a host names it by its route path.
 * `createSkillRoutes` records every module it makes a route of.
 *
 * A scenario file and the agent's discovery import a skill by the same file URL, so they hold
 * the same module and its `default` is the one recorded. A second copy of the module (another
 * loader, a bundle) has a component of its own: it is found by its name and source text, as
 * long as exactly one route has a component like it. Route path strings stay the stable form.
 */

const byComponent = new WeakMap<object, string>();
const bySource = new Map<string, Set<string>>();

const sourceKey = (component: Function) => `${component.name}\n${Function.prototype.toString.call(component)}`;

/** Record that `component` (a skill module's `default`) renders the skill at `path`. */
export function rememberSkillModule(component: Function, path: string): void {
  byComponent.set(component, path);
  const key = sourceKey(component);
  const paths = bySource.get(key) ?? new Set<string>();
  paths.add(path);
  bySource.set(key, paths);
}

/** The route path of the skill whose module's `default` is `component`; undefined when no
 * route was discovered for it in this process, or more than one route has a component like it. */
export function skillPathOfComponent(component: Function): string | undefined {
  const known = byComponent.get(component);
  if (known !== undefined) return known;
  const paths = bySource.get(sourceKey(component));
  return paths?.size === 1 ? [...paths][0] : undefined;
}
