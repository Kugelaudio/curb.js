import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  LockIcon,
  PlugIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { openSignIn } from "./open-sign-in.js";
import { cn } from "@/lib/utils.js";
import type { McpServerSummary } from "../mcp/manager.js";
import { NewBadge } from "./agent-view.js";
import type { McpGroup, SkillNode, TreeTool } from "./context-tree.js";
import { resolveIcon } from "./icon.js";

/**
 * The Context tab: what is always available (the agent's instructions, its tools, its MCP
 * servers), then the skills as the folders they live in, each skill's own tools nested
 * under it, because those work only while it is in use.
 */
export function ContextTreeView({
  instructions,
  tools,
  mcp,
  skills,
  initiallyOpen,
  liveSkillPath,
  builtIn,
  onOpenInstructions,
  onOpenSkill,
  onTry,
  onMcpConnect,
  onMcpDisconnect,
  onMcpRemove,
}: {
  instructions: { firstSentence: string; size: string; isNew: boolean; empty: boolean };
  tools: readonly TreeTool[];
  mcp: readonly McpGroup[];
  skills: readonly SkillNode[];
  /** Skills that start expanded; recomputed as the conversation moves. */
  initiallyOpen: ReadonlySet<string>;
  liveSkillPath: string;
  builtIn: readonly string[];
  onOpenInstructions: () => void;
  onOpenSkill: (path: string) => void;
  onTry: (tool: TreeTool) => void;
  onMcpConnect: (id: string) => void;
  onMcpDisconnect: (id: string) => void;
  onMcpRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initiallyOpen));
  // When the agent moves to another skill, open what it needs to show there too; what the
  // viewer opened or closed stays as it is.
  useEffect(() => {
    setOpen((current) => new Set([...current, ...initiallyOpen]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSkillPath]);
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex flex-col">
      <section className="px-6 pt-[22px] pb-6">
        <h3 className="m-0 text-[15px] font-semibold">Always available</h3>
        <button
          type="button"
          className="group/row -mx-2 mt-3.5 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-[10px] p-2 text-left hover:bg-accent"
          onClick={onOpenInstructions}
        >
          <RowIcon icon={FileTextIcon} />
          <RowText
            label="Instructions"
            isNew={instructions.isNew}
            detail={instructions.empty ? "None yet: add a <SystemPrompt> to your agent." : instructions.firstSentence}
          />
          {instructions.empty ? null : (
            <span className="shrink-0 text-[0.78rem] text-muted-foreground">{instructions.size}</span>
          )}
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>

        <GroupLabel id="context-tools">Tools</GroupLabel>
        {tools.length === 0 ? <EmptyLine>None</EmptyLine> : null}
        {tools.map((tool) => (
          <ToolRow key={tool.name} tool={tool} onTry={onTry} />
        ))}

        {mcp.length > 0 ? (
          <>
            <GroupLabel>MCP servers</GroupLabel>
            {mcp.map((group) => (
              <McpServerRow
                key={group.server.id}
                group={group}
                onTry={onTry}
                onConnect={onMcpConnect}
                onDisconnect={onMcpDisconnect}
                onRemove={onMcpRemove}
              />
            ))}
          </>
        ) : null}
      </section>

      <section className="border-t border-border/70 px-6 pt-[22px] pb-6">
        <h3 className="m-0 mb-2.5 text-[15px] font-semibold">Skills</h3>
        {skills.length === 0 ? <EmptyLine>None</EmptyLine> : null}
        {skills.map((skill) => (
          <SkillBranch key={skill.path} skill={skill} open={open} onToggle={toggle} onOpen={onOpenSkill} onTry={onTry} />
        ))}
      </section>

      {builtIn.length > 0 ? (
        <p className="m-0 border-t border-border/70 px-6 pt-3 pb-3.5 text-[0.78rem] text-muted-foreground">
          Built in: {builtIn.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function GroupLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h4 id={id} className="m-0 mt-6 mb-1.5 scroll-mt-4 text-[0.8125rem] font-semibold">
      {children}
    </h4>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="m-0 py-1 text-[0.8125rem] text-muted-foreground">{children}</p>;
}

/** A plain 16 px icon in the muted colour, in a 20 px slot: no tile. */
function RowIcon({ icon: Icon }: { icon: typeof WrenchIcon }) {
  return (
    <span className="grid w-5 shrink-0 place-items-center text-muted-foreground">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

/** A row's text as the Instructions row has it: the name with its New mark, and under it,
 * when there is one, a single muted line. The ids let a row's button point at its parts. */
function RowText({
  label,
  isNew,
  detail,
  labelId,
  detailId,
}: {
  label: string;
  isNew: boolean;
  detail?: string;
  labelId?: string;
  detailId?: string;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <span id={labelId} className="truncate">
          {label}
        </span>
        {isNew ? <NewBadge /> : null}
      </span>
      {detail ? (
        <span id={detailId} className="truncate text-[0.8125rem] text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </span>
  );
}

/** The chevron's slot. The guide line under a branch's children runs through its centre
 * (see `Branch`), so its width is the one number both have to agree on. */
const CHEVRON_SLOT = "w-4";

/** The keyboard focus ring of a skill row's two buttons, as the preview's other bare buttons have it. */
const FOCUS_RING = "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

function Chevron({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      className={cn(
        CHEVRON_SLOT,
        "grid h-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground",
        FOCUS_RING,
      )}
      onClick={onToggle}
    >
      {open ? <ChevronDownIcon className="size-3.5" aria-hidden="true" /> : <ChevronRightIcon className="size-3.5" aria-hidden="true" />}
    </button>
  );
}

/**
 * A branch's children, indented under it, with a 1 px guide line. Under a skill the line
 * sits exactly under the centre of its 16 px chevron slot (7.5 px, the line, 22.5 px);
 * under an MCP server, whose chevron is at the end of its row, it sits under the centre of
 * the server's 20 px icon slot (9.5 px, the line, 19.5 px). Either way the children start
 * where the parent's name does.
 */
function Branch({ under = "chevron", children }: { under?: "chevron" | "icon"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "border-l border-border/70",
        under === "chevron" ? "ml-[7.5px] pl-[22.5px]" : "ml-[9.5px] pl-[19.5px]",
      )}
    >
      {children}
    </div>
  );
}

/** The name, with its description in a tooltip when it has one. */
function Name({ text, description, className }: { text: string; description?: string; className?: string }) {
  const name = <span className={cn("truncate text-sm", className)}>{text}</span>;
  if (!description) return name;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("min-w-0 truncate text-sm", className)} />}>{text}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function toolIconOf(tool: TreeTool, fallback = WrenchIcon) {
  return resolveIcon(tool.icon) ?? fallback;
}

/** A tool: its icon, its name and Try. Its description is in the tooltip and the Try dialog. */
function ToolRow({
  tool,
  onTry,
  nested,
  fallbackIcon,
}: {
  tool: TreeTool;
  onTry: (tool: TreeTool) => void;
  /** Under a skill or server: keeps the chevron's slot so it lines up with sibling skills. */
  nested?: boolean;
  fallbackIcon?: typeof WrenchIcon;
}) {
  return (
    <div className="-mx-2 flex min-h-10 items-center gap-2.5 rounded-[10px] px-2 py-1 hover:bg-accent">
      {nested ? <span className={cn(CHEVRON_SLOT, "shrink-0")} /> : null}
      <RowIcon icon={toolIconOf(tool, fallbackIcon)} />
      <Name text={tool.name} description={tool.description} />
      {tool.isNew ? <NewBadge /> : null}
      <span className="flex-1" />
      <Button variant="outline" size="xs" className="h-7 px-2.5" onClick={() => onTry(tool)}>
        Try
      </Button>
    </div>
  );
}

/** What a skill holds, its direct sub-skills first: "2 skills · 1 tool", "1 tool", or null. */
export function skillContents(skill: Pick<SkillNode, "children" | "tools">): string | null {
  const counts = [
    [skill.children.length, "skill", "skills"],
    [skill.tools.length, "tool", "tools"],
  ] as const;
  const parts = counts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A skill row's meta: where the skill stands in the conversation, which wins, else what it holds. */
function skillMeta(skill: SkillNode): ReactNode {
  if (skill.state === "in-use") {
    return (
      <>
        <span className="size-[7px] rounded-full bg-success" aria-hidden="true" />
        In use
      </>
    );
  }
  if (skill.state === "read") return "Read";
  if (skill.state === "locked") {
    return (
      <>
        <LockIcon className="size-3.5" aria-hidden="true" />
        Locked
      </>
    );
  }
  return skillContents(skill);
}

/**
 * A skill, shaped like the Instructions row because it opens the same way: its name, its
 * description under it, where it stands or what it holds, and a trailing chevron. The
 * chevron in front expands its tools and sub-skills. The open button is named by the label
 * and described by the description and meta, so a screen reader hears the skill's name first.
 */
function SkillBranch({
  skill,
  open,
  onToggle,
  onOpen,
  onTry,
}: {
  skill: SkillNode;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onTry: (tool: TreeTool) => void;
}) {
  const id = useId();
  const expandable = skill.tools.length > 0 || skill.children.length > 0;
  const expanded = expandable && open.has(skill.path);
  const Icon = resolveIcon(skill.icon) ?? (skill.interactive ? ZapIcon : FileTextIcon);
  const meta = skillMeta(skill);
  const describedBy = [skill.description ? `${id}-description` : null, meta ? `${id}-meta` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <div className="-mx-2 flex min-h-10 items-center gap-2.5 rounded-[10px] px-2 py-1 hover:bg-accent">
        {expandable ? (
          <Chevron open={expanded} label={skill.label} onToggle={() => onToggle(skill.path)} />
        ) : (
          <span className={cn(CHEVRON_SLOT, "shrink-0")} />
        )}
        <button
          type="button"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy || undefined}
          aria-haspopup="dialog"
          className={cn("flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-lg py-1 text-left", FOCUS_RING)}
          onClick={() => onOpen(skill.path)}
        >
          <RowIcon icon={Icon} />
          <RowText
            label={skill.label}
            isNew={skill.isNew}
            detail={skill.description}
            labelId={`${id}-label`}
            detailId={`${id}-description`}
          />
          {meta ? (
            <span id={`${id}-meta`} className="flex shrink-0 items-center gap-1.5 text-[0.78rem] text-muted-foreground">
              {meta}
            </span>
          ) : null}
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <Branch>
          {skill.tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} onTry={onTry} nested />
          ))}
          {skill.children.map((child) => (
            <SkillBranch key={child.path} skill={child} open={open} onToggle={onToggle} onOpen={onOpen} onTry={onTry} />
          ))}
        </Branch>
      ) : null}
    </>
  );
}

function serverHost(server: McpServerSummary): string | null {
  if (!server.url) return null;
  try {
    return new URL(server.url).host;
  } catch {
    return server.url;
  }
}

/**
 * An MCP server: its name, how many tools it brings when connected, and it expands to
 * where it lives, what went wrong, the actions it needs and its tools. A server that needs
 * signing in says so on its row, because nothing works until someone does.
 */
function McpServerRow({
  group,
  onTry,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  group: McpGroup;
  onTry: (tool: TreeTool) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { server, tools } = group;
  const [expanded, setExpanded] = useState(false);
  // Signing in is one click: when the server answers "Sign in" with its login page, open it.
  const pendingSignIn = useRef(false);
  useEffect(() => {
    if (!pendingSignIn.current || server.status !== "auth_required" || !server.authUrl) return;
    pendingSignIn.current = false;
    openSignIn(server.authUrl);
  }, [server.status, server.authUrl]);
  const signIn = () => {
    if (server.authUrl) {
      openSignIn(server.authUrl);
      return;
    }
    pendingSignIn.current = true;
    onConnect(server.id);
  };
  const host = serverHost(server);
  const toolCount = server.toolCount ?? tools.length;

  return (
    <>
      <div className="-mx-2 flex min-h-10 items-center gap-2.5 rounded-[10px] px-2 py-1 hover:bg-accent">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          <RowIcon icon={PlugIcon} />
          <span className="truncate text-sm">{server.id}</span>
          <span className="flex-1" />
          {server.status === "auth_required" ? null : <ServerStatus server={server} toolCount={toolCount} />}
        </button>
        {server.status === "auth_required" ? (
          <Button variant="outline" size="xs" className="h-7 px-2.5" onClick={signIn}>
            Sign in
          </Button>
        ) : null}
        <button
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${server.id}`}
          className="grid size-5 shrink-0 place-items-center text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDownIcon className="size-3.5" aria-hidden="true" /> : <ChevronRightIcon className="size-3.5" aria-hidden="true" />}
        </button>
      </div>
      {expanded ? (
        <Branch under="icon">
          <div className="flex flex-col gap-1 py-1.5 text-[0.8125rem]">
            {host ? <span className="text-muted-foreground">{host}</span> : null}
            {server.status === "auth_required" ? (
              <span className="text-muted-foreground">Sign in before its tools work.</span>
            ) : null}
            {server.status === "error" && server.message ? (
              <span className="break-words text-destructive">{server.message}</span>
            ) : null}
            <span className="mt-1 flex flex-wrap gap-2">
              {server.status === "ready" ? (
                <Button variant="outline" size="xs" onClick={() => onDisconnect(server.id)}>
                  Disconnect
                </Button>
              ) : server.status === "disconnected" || server.status === "error" ? (
                <Button variant="outline" size="xs" onClick={() => onConnect(server.id)}>
                  {server.status === "error" ? "Retry" : "Connect"}
                </Button>
              ) : null}
              {server.removable ? (
                <Button variant="ghost" size="xs" className="text-destructive" onClick={() => onRemove(server.id)}>
                  Remove
                </Button>
              ) : null}
            </span>
          </div>
          {tools.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={{ name: tool.name, description: tool.description, icon: tool.icon, definition: tool, isNew: false }}
              onTry={onTry}
              fallbackIcon={PlugIcon}
            />
          ))}
        </Branch>
      ) : null}
    </>
  );
}

function ServerStatus({ server, toolCount }: { server: McpServerSummary; toolCount: number }) {
  const ready = server.status === "ready";
  const connecting = server.status === "connecting";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[0.78rem] text-muted-foreground">
      <span
        className={cn("size-[7px] rounded-full", ready ? "bg-success" : connecting ? "bg-border" : "bg-destructive")}
        aria-hidden="true"
      />
      {ready ? `${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : connecting ? "Connecting…" : "Not connected"}
    </span>
  );
}
