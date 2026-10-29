import { useState } from "react";
import { ChevronRightIcon, FileTextIcon, WrenchIcon, ZapIcon } from "lucide-react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { getBlockPreview } from "../blocks/preview-registry.js";
import type { BlockPreviewApi } from "../blocks/types.js";
import { resolvePublicMarkdown } from "../public-context.js";
import type { CompiledContext, ToolDefinition } from "../types.js";
import { NewBadge } from "./agent-view.js";
import { resolveIcon } from "./icon.js";
import { Prose } from "./prose.js";
import { resolveSegmentValues, type BlueprintNode } from "./skill-blueprint.js";

type PageBlock = CompiledContext["blocks"][number];

/**
 * A skill's page as the model reads it, in the order the author wrote it: instructions and
 * text as formatted prose, documents as rows that open them, links to other skills, the
 * pattern blocks (a procedure's stepper) and the tools where they were placed.
 */
export function SkillContent({
  blocks,
  tools,
  claimedTools,
  templateNodes,
  newToolNames,
  untryable,
  blockApi,
  onTry,
  onOpenSkill,
}: {
  blocks: readonly PageBlock[];
  /** The page's own tools, for the tool blocks. */
  tools: readonly ToolDefinition[];
  /** Tools a pattern block renders itself. */
  claimedTools: ReadonlySet<string>;
  /** Blueprint nodes with `{expr}` holes, to mark what the runtime filled in. */
  templateNodes: readonly BlueprintNode[];
  newToolNames: ReadonlySet<string>;
  untryable: ReadonlySet<string>;
  blockApi: BlockPreviewApi;
  onTry: (tool: ToolDefinition) => void;
  onOpenSkill: (path: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "instruction":
          case "text":
            return (
              <ProseBlock key={key} block={block} templateNodes={templateNodes} onOpenSkill={onOpenSkill} />
            );
          case "doc":
            return <DocumentRow key={key} src={block.src} />;
          case "link":
            return (
              <SkillLinkRow
                key={key}
                to={block.to}
                label={block.label}
                description={block.description}
                onOpen={onOpenSkill}
              />
            );
          case "tool": {
            if (claimedTools.has(block.name)) return null;
            const tool = tools.find((candidate) => candidate.name === block.name);
            return tool ? (
              <ToolLine
                key={key}
                tool={tool}
                isNew={newToolNames.has(tool.name)}
                blocked={untryable.has(tool.name)}
                onTry={onTry}
              />
            ) : null;
          }
          case "block": {
            const Preview = getBlockPreview(block.name);
            return Preview ? (
              <Preview key={key} payload={block.payload} api={blockApi} />
            ) : (
              <p key={key} className="ctx-text-error">
                Unknown block "{block.name}": register a preview in src/blocks/preview-registry.tsx.
              </p>
            );
          }
          case "error":
            return block.source ? null : (
              <p key={key} className="ctx-text-error">
                {block.text}
              </p>
            );
        }
      })}
    </div>
  );
}

/** A tool on a skill's page: its name, and Try. When the conversation unlocked it, test
 * runs cannot reach it, and the line says so instead of offering one. */
export function ToolLine({
  tool,
  isNew,
  blocked,
  onTry,
}: {
  tool: ToolDefinition;
  isNew: boolean;
  blocked: boolean;
  onTry: (tool: ToolDefinition) => void;
}) {
  const Icon = resolveIcon(tool.icon) ?? WrenchIcon;
  return (
    <div className="-mx-2 flex min-h-10 items-center gap-2.5 rounded-[10px] px-2 py-1 hover:bg-accent">
      <span className="grid w-5 shrink-0 place-items-center text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate">{tool.name}</span>
          {isNew ? <NewBadge /> : null}
        </span>
        {tool.description ? (
          <span className="line-clamp-2 text-[0.8125rem] text-muted-foreground">{tool.description}</span>
        ) : null}
        {blocked ? (
          <span className="text-[0.8125rem] text-muted-foreground">
            The conversation unlocked this tool, so test runs cannot reach it. Try it by asking the agent.
          </span>
        ) : null}
      </span>
      {blocked ? null : (
        <Button variant="outline" size="xs" className="h-7 px-2.5" onClick={() => onTry(tool)}>
          Try
        </Button>
      )}
    </div>
  );
}

function ProseBlock({
  block,
  templateNodes,
  onOpenSkill,
}: {
  block: Extract<PageBlock, { type: "instruction" | "text" }>;
  templateNodes: readonly BlueprintNode[];
  onOpenSkill: (path: string) => void;
}) {
  // Prose with `<Skill>` links written inside it: the links stay in the flow, and open.
  if (block.type === "text" && block.segments && block.segments.length > 0) {
    return (
      <p className="m-0 whitespace-pre-line">
        {block.segments.map((segment, index) =>
          segment.kind === "text" ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <button
              key={index}
              type="button"
              className="font-medium underline decoration-border underline-offset-3 hover:decoration-foreground"
              title={segment.description}
              onClick={() => onOpenSkill(segment.to)}
            >
              {segment.label}
            </button>
          ),
        )}
      </p>
    );
  }
  if (block.text.includes("\n")) return <Prose text={block.text} />;
  return (
    <p className="m-0">
      <TemplatedText text={block.text} templateNodes={templateNodes} />
    </p>
  );
}

/**
 * Rendered text with the spans the runtime filled in marked: the blueprint knows the
 * literal and `{expr}` parts, the matcher recovers which parts of this line were filled.
 * A matched hole shows lightly, with a tooltip naming the expression it came from; text
 * that does not match renders plain, never wrongly marked.
 */
function TemplatedText({ text, templateNodes }: { text: string; templateNodes: readonly BlueprintNode[] }) {
  for (const node of templateNodes) {
    if (!node.segments) continue;
    const values = resolveSegmentValues(node.segments, [text]);
    if (!values) continue;
    let hole = -1;
    return (
      <>
        {node.segments.map((segment, index) => {
          if (!segment.dynamic) return <span key={index}>{segment.text}</span>;
          hole += 1;
          return (
            <Tooltip key={index}>
              <TooltipTrigger render={<span className="rounded-md bg-accent px-1" />}>{values[hole]}</TooltipTrigger>
              <TooltipContent>Filled in from {segment.text}</TooltipContent>
            </Tooltip>
          );
        })}
      </>
    );
  }
  return <>{text}</>;
}

/** Blueprint nodes with template holes, children and block sections included. */
export function templatedNodes(nodes: readonly BlueprintNode[]): BlueprintNode[] {
  return nodes.flatMap((node) => [
    ...(node.segments?.some((segment) => segment.dynamic) ? [node] : []),
    ...templatedNodes(node.children),
    ...templatedNodes((node.sections ?? []).flatMap((section) => section.children)),
  ]);
}

/** A `<Skill>` link on the page: it opens that skill. */
function SkillLinkRow({
  to,
  label,
  description,
  onOpen,
}: {
  to: string;
  label: string;
  description?: string;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="-mx-2 flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-accent"
      onClick={() => onOpen(to)}
    >
      <span className="grid w-5 shrink-0 place-items-center text-muted-foreground">
        <ZapIcon className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{label}</span>
        {description ? <span className="line-clamp-2 text-[0.8125rem] text-muted-foreground">{description}</span> : null}
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/** A `<Text src>` document: a row that opens its markdown. The model gets the whole text. */
function DocumentRow({ src }: { src: string }) {
  const [open, setOpen] = useState(false);
  let markdown: string;
  try {
    markdown = resolvePublicMarkdown(src);
  } catch (error) {
    // The resolver's error lists the files that do exist: show it instead of a blank dialog.
    markdown = error instanceof Error ? error.message : String(error);
  }
  return (
    <>
      <button
        type="button"
        className="-mx-2 flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => setOpen(true)}
      >
        <span className="grid w-5 shrink-0 place-items-center text-muted-foreground">
          <FileTextIcon className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate">{src}</span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>{src}</DialogTitle>
            <DialogDescription>The model reads the whole document.</DialogDescription>
          </DialogHeader>
          <div className="markdown-message text-[0.9rem] leading-relaxed">
            <Streamdown mode="static">{markdown}</Streamdown>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
