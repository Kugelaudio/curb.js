/**
 * Self-starting entry for the headless agent server (`npm run server` inside
 * the package). Project-facing starts go through the CLI (`curb server`,
 * `curb dev`), which call {@link createAgentServer} directly.
 */
import { createAgentServer } from "./main.js";

const server = await createAgentServer();
await server.listen();
