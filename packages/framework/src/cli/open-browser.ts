import { spawn } from "node:child_process";

/** Open `url` in the default browser — pure convenience, never load-bearing:
 * every caller also prints the URL. */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {
        // KEEP-JUSTIFIED: no opener available (headless box) — the caller
        // already printed the URL; failing the command over this would be worse.
      })
      .unref();
  } catch {
    // KEEP-JUSTIFIED: same as above — opening a browser is best-effort.
  }
}
