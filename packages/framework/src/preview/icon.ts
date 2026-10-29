import { icons, type LucideIcon } from "lucide-react";

/**
 * Author-chosen icons.
 *
 * An icon is a plain kebab-case lucide name ("lock", "shield-check") carried
 * as a STRING through the compiled context and the WS protocol. It has to be a
 * string rather than a component: the runtime lives server-side and ships JSON
 * frames, so a component reference could never reach the preview.
 *
 * The framework stores the name opaquely and resolves it in this one place. It
 * never attaches meaning to a particular icon, which is what keeps this a
 * presentation hint rather than framework vocabulary.
 */

/** "shield-check" -> "ShieldCheck", lucide's export name. */
function pascalCase(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * The component for an authored icon name, or undefined when the name is
 * absent or unknown. Callers fall back to their own default icon, so a typo
 * degrades to the default rather than blanking a card.
 *
 * A misspelled name is currently silent. Surfacing it belongs in authoring
 * diagnostics next to the other authoring mistakes, which needs the icon-name
 * list reachable from the Node-side check without pulling in React; that is
 * not built, so this does not pretend to report it.
 */
export function resolveIcon(name: string | undefined): LucideIcon | undefined {
  if (!name) return undefined;
  const key = pascalCase(name) as keyof typeof icons;
  return icons[key];
}
