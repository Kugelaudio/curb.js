import { useMemo } from "react";
import { Graph, layout } from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { FileTextIcon, LockIcon, ZapIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { cn } from "@/lib/utils.js";
import type { CompiledContext } from "../types.js";
import {
  AGENT_NODE_ID,
  buildSkillGraph,
  type SkillGraphEdge,
  type SkillGraphMeta,
} from "./agent-graph-model.js";
import { AgentSphere } from "./agent-sphere.js";
import { resolveIcon } from "./icon.js";
import type { SkillBlueprint } from "./skill-blueprint.js";

/** Where a skill stands in the conversation, as its node says it. */
type NodeState = "in-use" | "read" | "locked" | null;

type SkillNodeData = {
  path: string;
  label: string;
  description?: string;
  state: NodeState;
  interactive: boolean;
  iconName?: string;
  onOpen: (path: string) => void;
};

type AgentNodeData = { label: string; onOpen: () => void };

type GraphNode = Node<SkillNodeData, "skill"> | Node<AgentNodeData, "agent">;

type EdgeData = {
  state: SkillGraphEdge["state"];
  /** The condition this branch waits for, as its author wrote it. */
  condition?: string;
};

type GraphEdge = Edge<EdgeData, "link">;

const NODE_WIDTH = 210;
const NODE_HEIGHT = 48;
const EDGE_COLOR = "hsl(40 4% 72%)";

function SkillCard({ data }: NodeProps<Node<SkillNodeData, "skill">>) {
  const Icon = resolveIcon(data.iconName) ?? (data.interactive ? ZapIcon : FileTextIcon);
  return (
    <div
      className={cn(
        "nopan relative rounded-[14px] border bg-card shadow-[0_2px_6px_rgb(0_0_0/0.04)]",
        data.state === "in-use" ? "border-foreground ring-3 ring-foreground/8" : "border-border",
        data.state === "locked" && "border-dashed",
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-transparent" />
      <button
        type="button"
        className="nodrag nopan flex size-full items-center gap-2.5 rounded-[14px] px-3 text-left hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        title={data.description}
        aria-label={`Open skill ${data.label}`}
        onClick={() => data.onOpen(data.path)}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{data.label}</span>
        {data.state === "in-use" ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-[7px] rounded-full bg-success" aria-hidden="true" />
            In use
          </span>
        ) : data.state === "read" ? (
          <span className="shrink-0 text-xs text-muted-foreground">Read</span>
        ) : data.state === "locked" ? (
          <LockIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Locked" />
        ) : null}
      </button>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-transparent" />
    </div>
  );
}

/** The graph's first node: the agent, whose instructions every skill shares. */
function AgentCard({ data }: NodeProps<Node<AgentNodeData, "agent">>) {
  return (
    <div className="nopan relative rounded-[14px] border border-border bg-card" style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}>
      <button
        type="button"
        className="nodrag nopan flex size-full items-center gap-2.5 rounded-[14px] px-3 text-left hover:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label={`Show ${data.label}'s instructions`}
        onClick={data.onOpen}
      >
        <AgentSphere size={18} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{data.label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">Instructions</span>
      </button>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-transparent" />
    </div>
  );
}

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<GraphEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: EDGE_COLOR, strokeWidth: 1.5, strokeDasharray: data?.state === "locked" ? "5 5" : undefined }}
      />
      {data?.condition ? (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan absolute max-w-[150px] truncate rounded-full border border-border/70 bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={data.condition}
          >
            {data.condition}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const nodeTypes = { skill: SkillCard, agent: AgentCard };
const edgeTypes = { link: LinkEdge };

function conditionText(edge: SkillGraphEdge): string | undefined {
  if (!edge.polarity || !edge.decision) return undefined;
  return edge.polarity === "positive" ? `if ${edge.decision}` : `if not ${edge.decision}`;
}

export type AgentGraphProps = {
  /** The conversation's context: what is in use and what the agent can open now. */
  context: CompiledContext;
  blueprints: ReadonlyMap<string, SkillBlueprint | null>;
  agentBlueprint: SkillBlueprint | null;
  skillMetadata: ReadonlyMap<string, SkillGraphMeta>;
  interactivePaths: ReadonlySet<string>;
  gatedPaths: ReadonlySet<string>;
  agentLabel: string;
  onOpenSkill: (path: string) => void;
  onOpenAgent: () => void;
};

function useGraph(props: AgentGraphProps): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { context, blueprints, agentBlueprint, skillMetadata, interactivePaths, gatedPaths, agentLabel, onOpenSkill, onOpenAgent } = props;
  return useMemo(() => {
    const topology = buildSkillGraph(context, blueprints, agentBlueprint, skillMetadata);
    const loaded = new Set(context.loadedSkills.map((skill) => skill.path));
    const graph = new Graph().setDefaultEdgeLabel(() => ({}));
    graph.setGraph({ rankdir: "TB", ranker: "network-simplex", nodesep: 28, edgesep: 16, ranksep: 72, marginx: 0, marginy: 0 });
    graph.setNode(AGENT_NODE_ID, { width: NODE_WIDTH, height: NODE_HEIGHT });
    for (const node of topology.nodes) graph.setNode(node.path, { width: NODE_WIDTH, height: NODE_HEIGHT });
    for (const edge of topology.edges) graph.setEdge(edge.source, edge.target);
    layout(graph);
    const position = (id: string) => {
      const { x, y } = graph.node(id) as { x: number; y: number };
      return { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 };
    };
    const stateOf = (path: string, locked: boolean): NodeState =>
      path === context.path ? "in-use" : loaded.has(path) ? "read" : locked || gatedPaths.has(path) ? "locked" : null;

    const nodes: GraphNode[] = [
      {
        id: AGENT_NODE_ID,
        type: "agent",
        position: position(AGENT_NODE_ID),
        data: { label: agentLabel, onOpen: onOpenAgent },
        draggable: false,
        selectable: false,
      },
      ...topology.nodes.map<GraphNode>((node) => ({
        id: node.path,
        type: "skill",
        position: position(node.path),
        data: {
          path: node.path,
          label: node.label,
          description: node.description,
          state: stateOf(node.path, node.state === "locked"),
          interactive: interactivePaths.has(node.path),
          iconName: skillMetadata.get(node.path)?.icon,
          onOpen: onOpenSkill,
        },
        draggable: false,
        selectable: false,
      })),
    ];
    const edges = topology.edges.map<GraphEdge>((edge) => ({
      id: `${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: "link",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_COLOR },
      data: { state: edge.state, condition: conditionText(edge) },
    }));
    return { nodes, edges };
  }, [context, blueprints, agentBlueprint, skillMetadata, interactivePaths, gatedPaths, agentLabel, onOpenSkill, onOpenAgent]);
}

/** The canvas, the whole graph fitted to the dialog. */
function GraphCanvas(props: AgentGraphProps) {
  const graph = useGraph(props);
  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      noDragClassName="nodrag"
      noPanClassName="nopan"
      deleteKeyCode={null}
      aria-label="Your agent's skills and how it reaches them"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="hsl(40 4% 80%)" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

/**
 * The graph: the agent and the skills it can open, live, in a dialog large enough for the
 * whole of it. The skill in use is highlighted, a locked path is dashed, and a branch that
 * waits for a condition says which. The dialog's content mounts only while it is open.
 */
export function AgentGraphDialog({
  open,
  onOpenChange,
  ...props
}: AgentGraphProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[86vh] w-[min(1200px,94vw)] max-w-none gap-3 p-5 sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Graph</DialogTitle>
          <DialogDescription>
            The skills your agent can open, from the agent down. Dashed paths are locked until their condition holds.
          </DialogDescription>
        </DialogHeader>
        <div className="agent-graph relative min-h-0 flex-1 overflow-hidden rounded-[18px] bg-[hsl(0_0%_98.5%)]">
          <GraphCanvas {...props} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
