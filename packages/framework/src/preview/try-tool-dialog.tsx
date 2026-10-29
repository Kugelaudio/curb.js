import { useEffect, useState } from "react";
import { CheckIcon, CircleCheckIcon, CircleXIcon, CopyIcon, LoaderIcon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.js";
import type { CompiledContext, ToolDefinition } from "../types.js";
import type { ErrorScope, ToolRun } from "../server/protocol.js";
import { formFields, formFromInput, inputFromForm, type FormField, type FormValues } from "./tool-form.js";
import { copyToClipboard } from "./transcript-export.js";
import { argumentEntries, resultValue, ValueTree } from "./value-tree.js";

/** A tool to try: from the Context tab, a skill's sheet, or a call in the conversation. */
export type TryTarget = {
  name: string;
  /** The skill that declares it; absent for a tool that is always available. */
  skillPath?: string;
  /** Its definition from the conversation's context, when the context has it. */
  definition?: ToolDefinition;
};

/** The "Any" choice of an optional enum: the field left empty. */
const ANY = "__any__";

/** "0.4 s", "12 s", "under 0.1 s". */
export function runSeconds(ms: number): string {
  if (ms < 100) return "under 0.1 s";
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * Try a tool: its fields from its schema, run once on the preview's copy of the agent, the
 * result or the error. The conversation never sees it. Generic for every tool: the labels
 * are field names, the help is the schema's description, nothing is made up.
 */
export function TryToolDialog(props: {
  open: boolean;
  /** The tool the dialog shows, kept after it closes so it does not empty while it animates
   * closed; the next opening replaces it. */
  target: TryTarget | null;
  onClose: () => void;
  /** The input of the agent's newest call of this tool in the conversation, if it made one. */
  lastCall: Record<string, unknown> | null;
  /** The preview's copy of the skill the copy shows now. */
  copy: CompiledContext | null;
  toolRun: ToolRun | null;
  lastError: { scope: ErrorScope; message: string } | null;
  /** Open the tool's skill on the preview's copy, so a run can reach the tool. */
  onPrepare: (skillPath: string) => void;
  onRun: (target: TryTarget, input: Record<string, unknown>) => void;
}) {
  return (
    <Dialog open={props.open && props.target !== null} onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogContent>{props.target ? <TryTool key={props.target.name} {...props} target={props.target} /> : null}</DialogContent>
    </Dialog>
  );
}

type Outcome = { run: ToolRun } | { error: string };

function TryTool({
  target,
  onClose,
  lastCall,
  copy,
  toolRun,
  lastError,
  onPrepare,
  onRun,
}: Parameters<typeof TryToolDialog>[0] & { target: TryTarget }) {
  useEffect(() => {
    if (target.skillPath) onPrepare(target.skillPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.name, target.skillPath]);

  // A skill's tool runs on the preview's copy of that skill, which may lack it: a tool the
  // conversation unlocked is still locked there.
  const copyReady = !target.skillPath || copy?.path === target.skillPath;
  const copyTool = target.skillPath && copyReady ? copy?.tools.find((tool) => tool.name === target.name) : undefined;
  const definition = target.definition ?? copyTool;
  const blocked =
    target.skillPath && copyReady && !copyTool
      ? target.definition
        ? "The conversation unlocked this tool, so test runs cannot reach it. Try it by asking the agent."
        : "Your agent's code shows this tool only in another state of its skill, so there is nothing to try yet."
      : null;

  const fields = definition ? formFields(definition.inputSchema) : [];
  // Until it is edited, the form shows the tool's `tryWith` input, or nothing.
  const [edited, setEdited] = useState<FormValues | null>(null);
  const values = edited ?? formFromInput(fields, definition?.tryWith ?? {});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ run: ToolRun | null; error: unknown } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!pending) return;
    if (toolRun && toolRun !== pending.run && toolRun.name === target.name) {
      setOutcome({ run: toolRun });
      setPending(null);
    } else if (lastError && lastError !== pending.error && lastError.scope === "tool") {
      setOutcome({ error: lastError.message });
      setPending(null);
    }
  }, [toolRun, lastError, pending, target.name]);

  const run = () => {
    const parsed = inputFromForm(fields, values);
    if ("error" in parsed) {
      setFormError(parsed.error);
      return;
    }
    setFormError(null);
    setOutcome(null);
    setPending({ run: toolRun, error: lastError });
    onRun(target, parsed.input);
  };

  const description = definition?.description?.trim();
  const called = lastCall ? argumentEntries(lastCall, 3) : [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>Try {target.name}</DialogTitle>
        <DialogDescription>
          {description ? `${description}${/[.!?]$/.test(description) ? "" : "."} ` : ""}
          Runs the real tool; the conversation does not change.
        </DialogDescription>
      </DialogHeader>

      {blocked ? (
        <p className="m-0 text-sm text-muted-foreground">{blocked}</p>
      ) : !definition ? (
        <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
          Loading the tool
        </p>
      ) : (
        <>
          {lastCall && fields.length > 0 ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-border/70 px-3 py-2.5 text-[0.84rem]">
              <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                Your agent called it with{" "}
                <span className="text-foreground">
                  {called.length > 0 ? called.map(([key, value]) => `${key} ${value}`).join(", ") : "no arguments"}
                </span>
              </span>
              <Button variant="outline" size="sm" onClick={() => setEdited(formFromInput(fields, lastCall))}>
                Use these
              </Button>
            </div>
          ) : null}
          {fields.length === 0 ? <p className="m-0 text-sm text-muted-foreground">It takes no input.</p> : null}
          {fields.map((field) => (
            <Field
              key={field.name}
              field={field}
              value={values[field.name]}
              onChange={(value) => setEdited({ ...values, [field.name]: value })}
            />
          ))}
          {formError ? <p className="m-0 text-[0.8125rem] text-destructive">{formError}</p> : null}
        </>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!definition || Boolean(blocked) || !copyReady || pending !== null} onClick={run}>
          {pending ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : null}
          Run
        </Button>
      </DialogFooter>

      {outcome ? <RunResult outcome={outcome} /> : null}
    </>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const id = `try-${field.name}`;
  const text = typeof value === "string" ? value : "";
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="flex items-baseline gap-2 text-[0.8125rem] font-medium">
        {field.name}
        {field.required ? null : <span className="font-normal text-muted-foreground">optional</span>}
      </label>
      {field.control === "switch" ? (
        <Switch id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
      ) : field.control === "pills" ? (
        <ToggleGroup
          aria-labelledby={id}
          value={[text || ANY]}
          onValueChange={(next) => {
            const choice = next.at(-1);
            onChange(!choice || choice === ANY ? "" : choice);
          }}
        >
          {field.required ? null : <ToggleGroupItem value={ANY}>Any</ToggleGroupItem>}
          {field.enum!.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : field.control === "select" ? (
        <Select value={text || ANY} onValueChange={(next) => onChange(!next || next === ANY ? "" : String(next))}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue>{(selected: string) => (selected === ANY ? "Any" : selected)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {field.required ? null : <SelectItem value={ANY}>Any</SelectItem>}
            {field.enum!.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type={field.control === "number" ? "number" : field.control === "email" ? "email" : "text"}
          value={text}
          aria-describedby={field.description ? `${id}-help` : undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
      {field.description || field.control === "json" ? (
        <p id={`${id}-help`} className="m-0 -mt-0.5 text-[0.78rem] text-muted-foreground">
          {field.description}
          {field.control === "json" ? `${field.description ? " " : ""}Written as JSON.` : null}
        </p>
      ) : null}
    </div>
  );
}

function RunResult({ outcome }: { outcome: Outcome }) {
  const [copied, setCopied] = useState(false);
  const failed = "error" in outcome || outcome.run.error !== undefined;
  const message = "error" in outcome ? outcome.error : outcome.run.error;
  const value = "run" in outcome && !failed ? resultValue(outcome.run.result as { message?: string; data?: unknown }) : undefined;
  return (
    <section className="flex flex-col gap-2.5 border-t border-border/70 pt-4" aria-live="polite">
      <div className="flex items-center gap-2 text-[0.8125rem] font-medium">
        {failed ? (
          <CircleXIcon className="size-4 text-destructive" aria-hidden="true" />
        ) : (
          <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
        )}
        {failed ? "Failed" : "Done"}
        {"run" in outcome ? <span className="font-normal text-muted-foreground">{runSeconds(outcome.run.durationMs)}</span> : null}
        <span className="flex-1" />
        {!failed && value !== undefined ? (
          <Button
            variant="ghost"
            size="xs"
            className="font-normal text-muted-foreground"
            onClick={() =>
              void copyToClipboard(typeof value === "string" ? value : JSON.stringify(value, null, 2)).then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              })
            }
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
      </div>
      {failed ? (
        <p className="m-0 text-[0.8125rem] whitespace-pre-wrap text-destructive">{message}</p>
      ) : value === undefined ? (
        <p className="m-0 text-[0.8125rem] text-muted-foreground">Nothing returned.</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded-xl bg-accent px-3.5 py-3">
          <ValueTree value={value} className="text-[0.84rem]" />
        </div>
      )}
    </section>
  );
}
