/**
 * The mapping between a skill's internal path and its web URL.
 *
 * Its own module because two places need it and they must not disagree: the
 * preview pushes these onto history, and the chat panel links to them. Written
 * out twice, the first change to the route shape breaks whichever copy nobody
 * remembered.
 */

/** Internal skill path → web URL. */
export function skillUrl(path: string): string {
  return `/skill${path}`;
}

/** Web URL → internal skill path, or null if it isn't a skill route. */
export function skillPathFromUrl(url: string): string | null {
  if (url.startsWith("/skill/")) return url.slice("/skill".length);
  return null;
}
