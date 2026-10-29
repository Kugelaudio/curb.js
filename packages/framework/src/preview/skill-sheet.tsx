import { FileTextIcon, LockIcon, Undo2Icon, ZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.js";
import type { BlockPreviewApi } from "../blocks/types.js";
import type { CompiledContext, ToolDefinition } from "../types.js";
import { NewBadge, SkillLiveStatus, type SkillPageStatus } from "./agent-view.js";
import { resolveIcon } from "./icon.js";
import { SkillContent, templatedNodes, ToolLine } from "./skill-content.js";
import type { SkillBlueprint } from "./skill-blueprint.js";
import type { LockReason } from "./skill-lock.js";

export type SkillSheetSkill = {
  path: string;
  label: string;
  description?: string;
  icon?: string;
  interactive: boolean;
  isNew: boolean;
};

/**
 * A skill's full content, opened from its row: what it says (instructions, text,
 * documents, links), its tools, and, while it is locked, what opens it. The page is the
 * conversation's own when it is the skill the agent is on; otherwise the preview's copy,
 * which browsing and test runs use, and the status line says which.
 */
export function SkillSheet({
  skill,
  page,
  status,
  tried,
  canUndo,
  onUndo,
  lockReasons,
  skillLabel,
  blueprint,
  sourceToolNames,
  newToolNames,
  untryable,
  blockApi,
  onTry,
  onOpenSkill,
  onClose,
}: {
  /** Null while no sheet is open. */
  skill: SkillSheetSkill | null;
  /** The compile to show; null until the preview's copy of this skill arrives. */
  page: CompiledContext | null;
  status: SkillPageStatus;
  /** The viewer ran a tool on the preview's copy. */
  tried: boolean;
  canUndo: boolean;
  onUndo: () => void;
  lockReasons: readonly LockReason[];
  skillLabel: (path: string) => string;
  blueprint: SkillBlueprint | null;
  /** Tool names the skill's source states, conditional ones included. */
  sourceToolNames: readonly string[];
  newToolNames: ReadonlySet<string>;
  untryable: ReadonlySet<string>;
  blockApi: BlockPreviewApi;
  onTry: (tool: ToolDefinition) => void;
  onOpenSkill: (path: string) => void;
  onClose: () => void;
}) {
  const Icon = skill ? (resolveIcon(skill.icon) ?? (skill.interactive ? ZapIcon : FileTextIcon)) : FileTextIcon;
  return (
    <Sheet open={skill !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full gap-0 data-[side=right]:sm:max-w-[560px]">
        {skill ? (
          <>
            <SheetHeader className="gap-2 border-b border-border/70 pb-5">
              <div className="flex items-center gap-2.5">
                <Icon className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
                <SheetTitle>{skill.label}</SheetTitle>
                {skill.isNew ? <NewBadge /> : null}
              </div>
              {skill.description ? <SheetDescription>{skill.description}</SheetDescription> : null}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <SkillLiveStatus status={status} isNew={skill.isNew} tried={tried} />
                {canUndo ? (
                  <Button
                    variant="outline"
                    size="xs"
                    title="Undo the last tool you tried. It only resets this preview; your agent and the conversation are untouched."
                    onClick={onUndo}
                  >
                    <Undo2Icon aria-hidden="true" />
                    Undo last try
                  </Button>
                ) : null}
              </div>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pt-5 pb-8">
              {lockReasons.length > 0 ? <LockSection reasons={lockReasons} skillLabel={skillLabel} /> : null}
              {page ? (
                <PageSections
                  page={page}
                  blueprint={blueprint}
                  sourceToolNames={sourceToolNames}
                  newToolNames={newToolNames}
                  untryable={untryable}
                  blockApi={blockApi}
                  onTry={onTry}
                  onOpenSkill={onOpenSkill}
                />
              ) : (
                <div className="flex flex-col gap-2" role="status" aria-label="Loading the skill">
                  {[72, 88, 64].map((width) => (
                    <span key={width} className="h-3.5 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Heading({ children }: { children: string }) {
  return <h3 className="m-0 mb-1.5 text-[0.8125rem] font-semibold">{children}</h3>;
}

function LockSection({ reasons, skillLabel }: { reasons: readonly LockReason[]; skillLabel: (path: string) => string }) {
  return (
    <section>
      <Heading>When your agent can open it</Heading>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
        {reasons.map((reason, index) => (
          <li key={index} className="flex items-start gap-2">
            <LockIcon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              From <span className="font-medium">{skillLabel(reason.from)}</span>,{" "}
              {reason.when.kind === "condition" ? (
                <>
                  when <span className="rounded-md bg-accent px-1">{reason.when.source}</span> is{" "}
                  {reason.when.holds ? "true" : "false"}.
                </>
              ) : (
                <>while it shows “{reason.when.label}”.</>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PageSections({
  page,
  blueprint,
  sourceToolNames,
  newToolNames,
  untryable,
  blockApi,
  onTry,
  onOpenSkill,
}: {
  page: CompiledContext;
  blueprint: SkillBlueprint | null;
  sourceToolNames: readonly string[];
  newToolNames: ReadonlySet<string>;
  untryable: ReadonlySet<string>;
  blockApi: BlockPreviewApi;
  onTry: (tool: ToolDefinition) => void;
  onOpenSkill: (path: string) => void;
}) {
  // A live page carries the tools of every loaded skill; the sheet shows this skill's own.
  const ownTools = page.tools.filter(
    (tool) => tool.scope === "page" && (tool.skillPath ?? page.path) === page.path,
  );
  const placed = new Set(page.blocks.flatMap((block) => (block.type === "tool" ? [block.name] : [])));
  const claimed = new Set(
    page.blocks.flatMap((block) => (block.type === "block" && block.claimedTools ? block.claimedTools : [])),
  );
  const unplaced = ownTools.filter((tool) => !placed.has(tool.name) && !claimed.has(tool.name));
  const compiledNames = new Set(page.tools.map((tool) => tool.name));
  const elsewhere = sourceToolNames.filter((name) => !compiledNames.has(name));

  return (
    <>
      {page.blocks.length > 0 ? (
        <section>
          <SkillContent
            blocks={page.blocks}
            tools={ownTools}
            claimedTools={claimed}
            templateNodes={blueprint ? templatedNodes(blueprint.nodes) : []}
            newToolNames={newToolNames}
            untryable={untryable}
            blockApi={blockApi}
            onTry={onTry}
            onOpenSkill={onOpenSkill}
          />
        </section>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">This skill adds nothing to the context in this state.</p>
      )}
      {unplaced.length > 0 ? (
        <section>
          <Heading>Tools</Heading>
          {unplaced.map((tool) => (
            <ToolLine
              key={tool.id}
              tool={tool}
              isNew={newToolNames.has(tool.name)}
              blocked={untryable.has(tool.name)}
              onTry={onTry}
            />
          ))}
        </section>
      ) : null}
      {elsewhere.length > 0 ? (
        <p className="m-0 text-[0.8125rem] text-muted-foreground">
          Its code also has {elsewhere.join(", ")}, shown to the model only in another state of this skill.
        </p>
      ) : null}
    </>
  );
}
