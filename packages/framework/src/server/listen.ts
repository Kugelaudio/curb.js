import type { Server as HttpServer } from "node:http";
import { logError, logInfo } from "./log.js";

/**
 * Where a host listens. An explicitly configured port (`WS_PORT`, then `PORT`, which
 * `--port` sets) is used exactly, and a conflict is an error; the default 4000 walks up
 * (4001, 4002, …) so several `curb dev` instances run side by side without port handling.
 */
export type ListenPlan = { host: string; port: number; explicit: boolean };

export function listenPlan(env: NodeJS.ProcessEnv = process.env): ListenPlan {
  const configured = env.WS_PORT ?? env.PORT;
  return {
    host: env.WS_HOST ?? "127.0.0.1",
    port: Number(configured ?? 4000),
    explicit: configured !== undefined,
  };
}

const PORT_SCAN_LIMIT = 100;

/**
 * Bind `server` as `plan` says and resolve with the port it got. Port 0 (an explicit plan)
 * binds any free port: the agent server behind `curb dev`'s preview port does that.
 */
export function listenWithPortWalk(server: HttpServer, plan: ListenPlan): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      // Both listeners are registered per attempt and BOTH are removed on either
      // outcome: a callback passed to listen() would stay registered after
      // EADDRINUSE and fire again on the next attempt's successful bind (double
      // logs, wrong port captured).
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (!plan.explicit && error.code === "EADDRINUSE") {
          if (port + 1 >= plan.port + PORT_SCAN_LIMIT) {
            reject(
              new Error(
                `No free port between ${plan.port} and ${plan.port + PORT_SCAN_LIMIT - 1}. Set PORT to use a specific one.`,
              ),
            );
            return;
          }
          logInfo("dev", `port ${port} is in use, trying ${port + 1}…`);
          tryPort(port + 1);
          return;
        }
        // An explicitly configured port that is taken (or any other bind error) is
        // a misconfiguration: fail loudly, never mask it.
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        // Bind-time errors are handled above; from here on a server error is a
        // runtime fault.
        server.on("error", (error) => {
          logError("ws", `http server error: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        });
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, plan.host);
    };
    tryPort(plan.port);
  });
}
