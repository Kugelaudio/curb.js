import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./mcp-orders-server.mjs", import.meta.url));

/** The in-repo orders MCP server in a child process on 127.0.0.1: its URL, and every request
 * it has answered (`<http method> <json-rpc method>`), so a test sees whether anything connected. */
export async function startOrdersMcpServer(): Promise<{ child: ChildProcess; url: string; requests: string[] }> {
  const child = spawn(process.execPath, [SERVER], { stdio: ["ignore", "pipe", "inherit"] });
  const requests: string[] = [];
  const url = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the orders MCP server exited with ${code}`)));
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (line.startsWith("listening ")) resolve(`http://127.0.0.1:${line.slice("listening ".length)}/mcp`);
        else if (line.startsWith("request ")) requests.push(line.slice("request ".length));
      }
    });
  });
  return { child, url, requests };
}
