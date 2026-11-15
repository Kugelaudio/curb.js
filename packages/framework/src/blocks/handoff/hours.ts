/**
 * When a person can take a handed-off call: opening hours per weekday in one time zone, or a
 * function the author writes (holidays, a shared calendar).
 *
 *   { timeZone: "Europe/Berlin", open: { "mon-fri": "08:00-17:00", sat: "09:00-12:00" } }
 *
 * Browser-safe: plain data and `Intl` only.
 */

import { isTimeZone } from "../../llm/localized.js";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** Opening hours: per weekday (`mon`), or a run of weekdays (`mon-fri`), one or more
 * `"HH:MM-HH:MM"` windows in `timeZone`. A day no key names is closed. */
export interface OpeningHours {
  /** An IANA time zone, such as "Europe/Berlin". */
  timeZone: string;
  open: Partial<Record<Weekday | `${Weekday}-${Weekday}`, string | readonly string[]>>;
}

/** Whether someone is there at `now`: opening hours, or the author's own check. */
export type HandoffHours = OpeningHours | ((now: Date) => boolean | Promise<boolean>);

type Window = { from: number; until: number };

/** The windows of each weekday (0 is Sunday), or a TypeError naming what is wrong. */
export function parseOpeningHours(hours: OpeningHours): Window[][] {
  if (typeof hours !== "object" || hours === null || !isTimeZone(hours.timeZone)) {
    throw new TypeError(
      `hours needs timeZone as an IANA time zone, for example { timeZone: "Europe/Berlin", open: { "mon-fri": "08:00-17:00" } }; got ${JSON.stringify(hours?.timeZone)}.`,
    );
  }
  if (typeof hours.open !== "object" || hours.open === null) {
    throw new TypeError('hours needs open, for example { "mon-fri": "08:00-17:00", sat: "09:00-12:00" }.');
  }
  const days: Window[][] = WEEKDAYS.map(() => []);
  for (const [key, value] of Object.entries(hours.open)) {
    const windows = (typeof value === "string" ? [value] : (value ?? [])).map((window) => parseWindow(key, window));
    for (const day of weekdaysOf(key)) days[day]!.push(...windows);
  }
  return days;
}

/** Whether `now` is inside the opening hours. */
export function isOpenAt(days: Window[][], timeZone: string, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const day = WEEKDAYS.indexOf(part("weekday").toLowerCase().slice(0, 3) as Weekday);
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  return (days[day] ?? []).some((window) => minute >= window.from && minute < window.until);
}

/** Check `hours` when it renders: a TypeError for opening hours that cannot be read. */
export function checkHandoffHours(hours: HandoffHours | undefined): void {
  if (hours === undefined || typeof hours === "function") return;
  parseOpeningHours(hours);
}

/** Whether someone is there at `now`. No hours: always. */
export async function isWithinHours(hours: HandoffHours | undefined, now: Date): Promise<boolean> {
  if (hours === undefined) return true;
  if (typeof hours === "function") return (await hours(now)) === true;
  return isOpenAt(parseOpeningHours(hours), hours.timeZone, now);
}

function weekdaysOf(key: string): number[] {
  const [first, last, extra] = key.split("-");
  const from = WEEKDAYS.indexOf(first as Weekday);
  const to = last === undefined ? from : WEEKDAYS.indexOf(last as Weekday);
  if (from < 0 || to < 0 || extra !== undefined) {
    throw new TypeError(`hours.open has the key ${JSON.stringify(key)}; use a weekday (mon) or a run of them (mon-fri).`);
  }
  const days: number[] = [];
  for (let day = from; ; day = (day + 1) % 7) {
    days.push(day);
    if (day === to) return days;
  }
}

function parseWindow(key: string, window: unknown): Window {
  const match = typeof window === "string" ? /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window.trim()) : null;
  const minutes = match ? match.slice(1).map(Number) : [];
  const [fromHour, fromMinute, untilHour, untilMinute] = minutes as [number, number, number, number];
  const from = fromHour * 60 + fromMinute;
  const until = untilHour * 60 + untilMinute;
  if (!match || fromMinute > 59 || untilMinute > 59 || from >= until || until > 24 * 60) {
    throw new TypeError(
      `hours.open.${key} needs windows as "HH:MM-HH:MM" within one day, for example "08:00-17:00"; got ${JSON.stringify(window)}.`,
    );
  }
  return { from, until };
}
