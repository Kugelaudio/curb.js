import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type CloudClient, seg } from "./client.js";
import { CloudError, isHostedAgentsNotEnabled } from "./http.js";

/**
 * Which hosted agent this project deploys to: `.curb/link.json`.
 *
 * Written the first time `curb deploy` or `curb secrets push` resolves an agent, so every
 * later run is non-interactive. It names ids and the dashboard URL, never a credential.
 * `curb login` may write it first with only the project its API key belongs to
 * (`ProjectLink`); the first deploy then picks or creates the agent in that project.
 */
export interface ProjectLink {
  webUrl: string;
  orgId: string;
  projectId: string;
}

export interface Link extends ProjectLink {
  agentId: string;
  platformProjectId: string;
  environmentId: string;
  /** The agent's dashboard page. The dashboard routes by slugs, so it is built from them, not from the ids. */
  dashboardUrl: string;
}

const PROJECT_FIELDS = ["webUrl", "orgId", "projectId"] as const;
const AGENT_FIELDS = ["agentId", "platformProjectId", "environmentId", "dashboardUrl"] as const;
const LINK_FIELDS = [...PROJECT_FIELDS, ...AGENT_FIELDS] as const;

/** A link that names the agent, not only the project `curb login` chose. */
export function isAgentLink(link: ProjectLink | Link): link is Link {
  return "agentId" in link;
}

export function linkPath(root: string): string {
  return join(root, ".curb", "link.json");
}

/** The saved link: an agent's, or only a project's when `curb login` wrote it and nothing was deployed yet. */
export function readLink(root: string): Link | ProjectLink | null {
  const path = linkPath(root);
  if (!existsSync(path)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} is not valid JSON. Delete it and run the command again to pick the agent.`);
  }
  const absent = (field: string) => typeof parsed[field] !== "string" || parsed[field] === "";
  // A project link has none of the agent's fields; an agent link has them all.
  const required = AGENT_FIELDS.every(absent) ? PROJECT_FIELDS : LINK_FIELDS;
  const missing = required.filter(absent);
  if (missing.length > 0) {
    throw new Error(`${path} is missing ${missing.join(", ")}. Delete it and run the command again to pick the agent.`);
  }
  return parsed as unknown as Link | ProjectLink;
}

export function writeLink(root: string, link: Link | ProjectLink): void {
  mkdirSync(join(root, ".curb"), { recursive: true });
  const fields = isAgentLink(link) ? LINK_FIELDS : PROJECT_FIELDS;
  const ordered = Object.fromEntries(fields.map((field) => [field, (link as Link)[field]]));
  writeFileSync(linkPath(root), `${JSON.stringify(ordered, null, 2)}\n`);
}

/** Asks one question on the terminal. Null when there is no terminal to ask on. */
export interface Prompter {
  ask(question: string): Promise<string>;
}

interface AgentRecord {
  id: string;
  name: string;
  slug: string;
  platformProjectId: string;
}

interface AgentListing {
  orgs: Array<{
    id: string;
    name: string;
    slug: string;
    projects: Array<{
      id: string;
      name: string;
      slug: string;
      agents: AgentRecord[];
    }>;
  }>;
}

interface Choice {
  orgId: string;
  orgName: string;
  orgSlug: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  platformProjectId: string;
}

export interface ResolveTargetOptions {
  client: CloudClient;
  root: string;
  /** `--agent <id>`: skips the picker; replaces a link to another agent. */
  agentId?: string;
  prompter: Prompter | null;
  log: (line: string) => void;
}

/**
 * Right after `curb login`: whether the signed-in organization can deploy, from the agent
 * picker's own listing. When hosted agents are not switched on for it, the refusal is logged
 * now rather than at the first `curb deploy`. Signing in worked either way, so nothing here
 * fails the login.
 */
export async function reportHostedAgentsAccess(client: CloudClient, log: (line: string) => void): Promise<void> {
  try {
    await client.web<AgentListing>("GET", "/api/cli/agents");
  } catch (error) {
    if (error instanceof CloudError && isHostedAgentsNotEnabled(error)) {
      log(error.message);
      return;
    }
    // KEEP-JUSTIFIED: any other refusal is not about the sign-in that just succeeded, and
    // `curb deploy` and `curb secrets push` read this listing first and report it in full.
  }
}

function refuseOtherWebUrl(existing: ProjectLink, webUrl: string): void {
  if (existing.webUrl === webUrl) return;
  throw new Error(
    `This project is linked to ${existing.webUrl}, but you are signed in to ${webUrl}. ` +
      `Run \`npx curb login --url ${existing.webUrl}\`, or delete .curb/link.json to pick an agent on ${webUrl}.`,
  );
}

/** The listing cut down to the one project a project link names; null when the account cannot see it. */
function onlyProject(listing: AgentListing, project: ProjectLink): AgentListing | null {
  const org = (listing.orgs ?? []).find((candidate) => candidate.id === project.orgId);
  const match = (org?.projects ?? []).find((candidate) => candidate.id === project.projectId);
  return org && match ? { orgs: [{ ...org, projects: [match] }] } : null;
}

/** The project's link, resolved and saved on first use. */
export async function resolveTarget(options: ResolveTargetOptions): Promise<Link> {
  const { client, root, log } = options;
  const webUrl = client.credentials.webUrl;
  const existing = readLink(root);
  if (existing && isAgentLink(existing) && (options.agentId === undefined || options.agentId === existing.agentId)) {
    refuseOtherWebUrl(existing, webUrl);
    return existing;
  }
  // The project `curb login` chose for this directory's API key: its agent is picked or
  // created there. `--agent` names the agent outright, wherever it is.
  const linkedProject = existing && !isAgentLink(existing) && options.agentId === undefined ? existing : null;
  if (linkedProject) refuseOtherWebUrl(linkedProject, webUrl);

  let { body: listing } = await client.web<AgentListing>("GET", "/api/cli/agents");
  if (linkedProject) {
    const scoped = onlyProject(listing, linkedProject);
    if (!scoped) {
      throw new Error(
        `.curb/link.json names project ${linkedProject.projectId}, which your account cannot deploy to on ${webUrl}. ` +
          "Sign in with `npx curb login` as an account in that project, or delete .curb/link.json to pick another.",
      );
    }
    listing = scoped;
  }
  const agents: Choice[] = (listing.orgs ?? []).flatMap((org) =>
    (org.projects ?? []).flatMap((project) =>
      (project.agents ?? []).map((agent) => ({
        orgId: org.id,
        orgName: org.name,
        orgSlug: org.slug,
        projectId: project.id,
        projectName: project.name,
        projectSlug: project.slug,
        agentId: agent.id,
        agentName: agent.name,
        agentSlug: agent.slug,
        platformProjectId: agent.platformProjectId,
      })),
    ),
  );

  let choice: Choice;
  if (options.agentId !== undefined) {
    const found = agents.find((agent) => agent.agentId === options.agentId);
    if (!found) {
      throw new Error(
        `No agent with id "${options.agentId}" in your organisations. ` +
          (agents.length > 0 ? `Yours:\n${agents.map(describe).join("\n")}` : "You have no agents yet; run without --agent to create one."),
      );
    }
    choice = found;
  } else {
    choice = await pickOrCreate(listing, agents, options);
  }

  const dashboardUrl = agentDashboardUrl(webUrl, choice);
  const environmentId = await ensureProductionEnvironment(client, choice.orgId, choice.platformProjectId);
  const link: Link = {
    webUrl,
    orgId: choice.orgId,
    projectId: choice.projectId,
    agentId: choice.agentId,
    platformProjectId: choice.platformProjectId,
    environmentId,
    dashboardUrl,
  };
  writeLink(root, link);
  log(`Linked to ${choice.orgName} / ${choice.projectName} / ${choice.agentName} (saved in .curb/link.json).`);
  return link;
}

/** `<web>/dashboard/<org>/<project>/agents/<agent>`, by slug: the dashboard does not route by id. */
function agentDashboardUrl(webUrl: string, choice: Choice): string {
  const slugs = [choice.orgSlug, choice.projectSlug, choice.agentSlug];
  if (slugs.some((slug) => typeof slug !== "string" || slug === "")) {
    throw new Error(
      `${webUrl} answered without the dashboard slugs for ${choice.orgName} / ${choice.projectName} / ${choice.agentName}, ` +
        "so its dashboard URL is unknown; nothing was linked.",
    );
  }
  return `${webUrl}/dashboard/${seg(choice.orgSlug)}/${seg(choice.projectSlug)}/agents/${seg(choice.agentSlug)}`;
}

function describe(agent: Choice): string {
  return `  ${agent.agentId}  ${agent.orgName} / ${agent.projectName} / ${agent.agentName}`;
}

async function pickOrCreate(listing: AgentListing, agents: Choice[], options: ResolveTargetOptions): Promise<Choice> {
  const projects = (listing.orgs ?? []).flatMap((org) =>
    (org.projects ?? []).map((project) => ({ org, project })),
  );
  if (projects.length === 0) {
    throw new Error(
      `Your account has no project to deploy into. Create one in ${options.client.credentials.webUrl}/dashboard, then run this again.`,
    );
  }
  const { prompter } = options;
  // No terminal (a coding agent, CI). The first-run case a coding agent hits is "no agent
  // yet, one project": that has exactly one sensible answer, so it is taken. Anything with
  // a real choice in it is refused with the ids to choose from.
  if (!prompter && agents.length === 0 && projects.length === 1) {
    return createAgent(options, projects[0], basename(options.root));
  }
  if (!prompter) {
    throw new Error(
      "This project is not linked to a hosted agent and there is no terminal to pick one. " +
        (agents.length > 0
          ? `Pass --agent <id>:\n${agents.map(describe).join("\n")}`
          : "You have several projects; run the command once in a terminal to choose where to create the agent."),
    );
  }

  const lines = agents.map((agent, index) => `  ${index + 1}) ${agent.orgName} / ${agent.projectName} / ${agent.agentName}`);
  lines.push(`  ${agents.length + 1}) Create a new agent`);
  const picked = await askNumber(prompter, `Deploy to which agent?\n${lines.join("\n")}\n> `, agents.length + 1);
  if (picked <= agents.length) return agents[picked - 1];

  let target = projects[0];
  if (projects.length > 1) {
    const projectLines = projects.map(({ org, project }, index) => `  ${index + 1}) ${org.name} / ${project.name}`);
    target = projects[(await askNumber(prompter, `Create it in which project?\n${projectLines.join("\n")}\n> `, projects.length)) - 1];
  }
  const fallbackName = basename(options.root);
  const name = (await prompter.ask(`Agent name (${fallbackName}): `)).trim() || fallbackName;
  return createAgent(options, target, name);
}

type ProjectRef = { org: AgentListing["orgs"][number]; project: AgentListing["orgs"][number]["projects"][number] };

async function createAgent(options: ResolveTargetOptions, target: ProjectRef, name: string): Promise<Choice> {
  const { body: created } = await options.client.web<AgentRecord>("POST", "/api/cli/agents", {
    orgId: target.org.id,
    projectId: target.project.id,
    name,
  });
  options.log(`Created agent ${created.name} (${created.id}) in ${target.org.name} / ${target.project.name}.`);
  return {
    orgId: target.org.id,
    orgName: target.org.name,
    orgSlug: target.org.slug,
    projectId: target.project.id,
    projectName: target.project.name,
    projectSlug: target.project.slug,
    agentId: created.id,
    agentName: created.name,
    agentSlug: created.slug,
    platformProjectId: created.platformProjectId,
  };
}

async function askNumber(prompter: Prompter, question: string, max: number): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = Number.parseInt((await prompter.ask(question)).trim(), 10);
    if (Number.isInteger(answer) && answer >= 1 && answer <= max) return answer;
  }
  throw new Error(`No valid choice between 1 and ${max}; nothing was linked.`);
}

interface EnvironmentList {
  environments: Array<{ id: string; slug: string; kind: string }>;
}

const PRODUCTION_ENVIRONMENT = { slug: "production", name: "Production", kind: "production" };

/**
 * The agent's production environment, created when it does not exist yet. Follows the usual
 * pattern: check, create, re-read, with a 409 on create
 * meaning another caller won the race (success, not failure).
 */
export async function ensureProductionEnvironment(
  client: CloudClient,
  tenant: string,
  platformProjectId: string,
): Promise<string> {
  const path = `/v1/agents/projects/${seg(platformProjectId)}/environments`;
  const pick = (list: EnvironmentList) =>
    list.environments.find((environment) => environment.kind === "production" && environment.slug === "production") ??
    list.environments.find((environment) => environment.kind === "production");

  const existing = pick((await client.platform<EnvironmentList>("GET", path, tenant)).body);
  if (existing) return existing.id;
  try {
    await client.platform("POST", path, tenant, PRODUCTION_ENVIRONMENT, `production-environment:${platformProjectId}`);
  } catch (error) {
    if (!(error instanceof CloudError && error.status === 409)) throw error;
  }
  const created = pick((await client.platform<EnvironmentList>("GET", path, tenant)).body);
  if (!created) {
    throw new Error(`The platform did not return a production environment for project ${platformProjectId} after creating it.`);
  }
  return created.id;
}
