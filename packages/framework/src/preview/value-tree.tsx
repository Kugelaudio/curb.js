import { cn } from "@/lib/utils.js";

/**
 * A tool's arguments and results as a plain key/value tree: keys muted on the left, values
 * on the right, nested values indented under their key, list items numbered from 1. The
 * same rendering for every tool, so nothing about a value is formatted for one domain.
 */

export type TreeRow = { depth: number; key?: string; value: string };

/** Rows past this are summarised, so a tool that returns thousands of items stays readable. */
const MAX_ROWS = 300;

/** A scalar as text. Strings stay as they are, without quotes. */
export function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function isBranch(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function entriesOf(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index + 1), item])
    : Object.entries(value);
}

/** The rows of `value`'s tree. A scalar is one row without a key. */
export function treeRows(value: unknown): TreeRow[] {
  if (!isBranch(value)) return [{ depth: 0, value: formatScalar(value) }];
  const rows: TreeRow[] = [];
  let hidden = 0;
  const walk = (branch: Record<string, unknown> | unknown[], depth: number) => {
    for (const [key, item] of entriesOf(branch)) {
      if (rows.length >= MAX_ROWS) {
        hidden += 1;
        continue;
      }
      if (isBranch(item) && entriesOf(item).length > 0) {
        rows.push({ depth, key, value: "" });
        walk(item, depth + 1);
      } else {
        rows.push({ depth, key, value: isBranch(item) ? (Array.isArray(item) ? "none" : "empty") : formatScalar(item) });
      }
    }
  };
  walk(value, 0);
  if (rows.length === 0) rows.push({ depth: 0, value: Array.isArray(value) ? "none" : "empty" });
  if (hidden > 0) rows.push({ depth: 0, value: `and ${hidden} more` });
  return rows;
}

/** What a tool's result says, without the `ok` flag its status icon already shows: its
 * `data`, its `message`, or both. */
export function resultValue(result: { ok?: boolean; message?: string; data?: unknown } | undefined): unknown {
  if (!result) return undefined;
  const { message, data } = result;
  if (data === undefined) return message;
  if (message === undefined) return data;
  return { message, data };
}

/** The first arguments of a call, shown beside its name. */
export function argumentEntries(input: Record<string, unknown> | undefined, count = 2): Array<[string, string]> {
  return Object.entries(input ?? {})
    .slice(0, count)
    .map(([key, value]) => [key, formatScalar(value)]);
}

export function ValueTree({ value, className }: { value: unknown; className?: string }) {
  const rows = treeRows(value);
  return (
    <div
      className={cn(
        "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3.5 gap-y-1 text-[0.8125rem] leading-[1.45]",
        className,
      )}
    >
      {rows.map((row, index) =>
        row.key === undefined ? (
          <span key={index} className="col-span-2 break-words whitespace-pre-wrap">
            {row.value}
          </span>
        ) : (
          <div key={index} className="contents">
            <span className="text-muted-foreground" style={{ paddingLeft: row.depth * 16 }}>
              {row.key}
            </span>
            <span className="min-w-0 break-words whitespace-pre-wrap">{row.value}</span>
          </div>
        ),
      )}
    </div>
  );
}
