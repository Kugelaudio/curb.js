import { curbVersion } from "../version.js";
import { bold, cyan, dim, green, red, yellow } from "./log.js";

/** What the boot banner says about the agent server, as data: `curb dev` runs the server in
 * a child process and prints the banner itself, on the preview's port. */
export type BootBanner = {
  agentIds: string[];
  defaultAgentId: string;
  /** Why voice is off, or null when it is ready. */
  voiceIssue: string | null;
  /** The host protocol's management address, when one is open. */
  management: string | null;
  hasMcp: boolean;
};

/**
 * Next.js-shaped banner: brand + version, aligned dash rows, then a green "Ready in Xms".
 * `failed`: the agent did not load at boot; `curb dev` keeps running and the preview shows
 * where it failed.
 */
export function printBootBanner(options: {
  url: string;
  /** `curb dev`: the browser preview is served on `url`. Else the headless WS server. */
  preview: boolean;
  banner: BootBanner | { failed: string };
}): void {
  const { url, preview, banner } = options;
  const row = (label: string, value: string) =>
    console.log(`   ${dim("-")} ${`${label}:`.padEnd(9)} ${value}`);
  console.log("");
  console.log(`   ${bold(`● curb ${curbVersion()}`)}`);
  if (preview) row("Preview", cyan(url));
  else row("Server", cyan(url.replace(/^http/, "ws")));
  if ("failed" in banner) {
    row("Agent", `${red("did not load")} ${dim(`— ${banner.failed}`)}`);
  } else {
    row(
      banner.agentIds.length > 1 ? "Agents" : "Agent",
      banner.agentIds.length > 1
        ? `${banner.agentIds.join(", ")} ${dim(`(default: ${banner.defaultAgentId})`)}`
        : banner.defaultAgentId,
    );
    if (banner.voiceIssue) {
      row("Voice", `${yellow("off")} ${dim(`— ${banner.voiceIssue}`)}`);
    } else {
      row("Voice", `ready ${dim(preview ? "— press Start call in the preview" : "— attach over the WS (voice_start)")}`);
    }
    if (banner.management !== null) {
      row("Host", `${cyan(`http://${banner.management}/v1`)} ${dim("— host protocol v1, calls by room name")}`);
    }
    if (banner.hasMcp) row("MCP", dim(`OAuth callback ${url}/oauth/callback`));
  }
  if (preview) row("Reload", dim("on save: src/, context/*.md and .env"));
  console.log("");
  console.log(` ${green("✓")} Ready in ${Math.round(process.uptime() * 1000)}ms`);
}
