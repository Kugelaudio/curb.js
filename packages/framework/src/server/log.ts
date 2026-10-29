/**
 * Next.js-style dev logs:
 *
 *    ✓ 19:24:03 voice  livekit agent joined room curb-80b48533
 *    ⚠ 19:24:05 ws     …warning…
 *    ⨯ 19:24:07 tts    …error…
 *
 * A severity symbol leads (green check / yellow warn / red cross), the
 * timestamp is dim, and the channel tag carries its own color so
 * interleaved logs scan at a glance; warnings and errors tint the whole
 * message. Plain ANSI only, disabled on non-TTY pipes and under NO_COLOR
 * (the boot banner in server/main.ts shares these paint helpers).
 */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export const paint =
  (code: string) =>
  (text: string): string =>
    useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");
const blue = paint("34");
const magenta = paint("35");

/** One color per log channel, so interleaved logs scan at a glance. */
const TAG_COLOR: Record<string, (text: string) => string> = {
  voice: cyan,
  ws: magenta,
  tts: blue,
  dev: green,
  curb: bold,
};

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** Widest channel tag — tags pad to this so messages align in a column. */
const TAG_WIDTH = 5;

function line(symbol: string, tag: string, message: string, tint?: (text: string) => string): string {
  const tagColor = tint ?? TAG_COLOR[tag] ?? bold;
  return ` ${symbol} ${dim(stamp())} ${tagColor(tag.padEnd(TAG_WIDTH))} ${message}`;
}

export function logInfo(tag: string, message: string): void {
  console.log(line(green("✓"), tag, message));
}

export function logWarn(tag: string, message: string): void {
  console.warn(line(yellow("⚠"), tag, yellow(message), yellow));
}

export function logError(tag: string, message: string): void {
  console.error(line(red("⨯"), tag, red(message), red));
}
