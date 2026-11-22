import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentDir, resolveProjectRoot } from "../project.node.js";
import type { StoredProjectKey } from "./cloud/credentials.js";
import { keepHostModelKeyFresh, useHostModelKey } from "./cloud/host-model-key.js";
import { useLoginKey } from "./cloud/project-key.js";

/** A project made ready to run in this process: its root, and the key `curb login` stored for it
 * when the project runs on that. */
export type PreparedProject = { projectRoot: string; loginKey: StoredProjectKey | null };

/** Where this process keeps the project it prepared: a registry symbol, so every copy of this
 * module (the CLI's, and `curb/testing` in a script `curb run` loads) sees the same one. */
const PREPARED = Symbol.for("curb.preparedProject");
const store = globalThis as typeof globalThis & { [PREPARED]?: PreparedProject };

/**
 * Validate the working directory as a project, load its .env, and export the root to every
 * framework host started in this process (server, preview). With no KUGELAUDIO_API_KEY in the
 * environment or .env, the project runs on the key `curb login` stored for it (`loginKey`, the
 * stored key when it did), else on the model key a host supplies beside its platform token (a
 * hosted workspace), kept current while it runs.
 */
export function prepareProject(): PreparedProject {
  const projectRoot = resolveProjectRoot();
  process.env.AGENT_PROJECT_DIR = projectRoot;
  resolveAgentDir(projectRoot);
  const envFile = join(projectRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const loginKey = useLoginKey(projectRoot);
  if (!loginKey) {
    useHostModelKey();
    keepHostModelKeyFresh();
  }
  store[PREPARED] = { projectRoot, loginKey };
  return store[PREPARED];
}

/** The project this process prepared, preparing it first when nothing has: a test runner or a
 * script that imports `curb/testing` gets what a `curb` command gets. */
export function ensureProjectPrepared(): PreparedProject {
  return store[PREPARED] ?? prepareProject();
}
