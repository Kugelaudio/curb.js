import { CLIENT_INFO_PREFIX, clientInfoProblem } from "../server/protocol.js";

/**
 * The page info the preview's own URL carries: `?client.event=webinar-11-04` sets `client.event`
 * on every conversation the page starts, the way a page an agent is embedded in sends it. Entries
 * outside the limits every route applies are refused, each with the reason, never sent.
 */
export function pageInfoFromQuery(search: string): { info: Record<string, string>; refused: string[] } {
  const info: Record<string, string> = {};
  const refused: string[] = [];
  for (const [name, value] of new URLSearchParams(search)) {
    if (!name.startsWith(CLIENT_INFO_PREFIX)) continue;
    const problem = clientInfoProblem(name.slice(CLIENT_INFO_PREFIX.length), value);
    if (problem) refused.push(problem);
    else info[name] = value;
  }
  return { info, refused };
}

/** The refusals as the one line the preview shows. */
export function refusedPageInfoNotice(refused: readonly string[]): string | null {
  if (refused.length === 0) return null;
  return `Not sent from the page URL: ${refused.join(" ")}`;
}
