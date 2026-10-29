import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One call's own writable directory: created when the call starts, removed when it ends.
 *
 * WHY PER CALL. A runner may serve several calls at once in one process. Anything a call
 * keeps on disk (a downloaded attachment, a generated file a tool hands back) must not be
 * readable by the call next to it, and must not outlive it: process exit is the cleanup of a
 * one-call runner, and a runner that serves calls back to back never exits between them.
 *
 * Under the OS temp directory (`$TMPDIR`), named at random and created mode 0700 by
 * `mkdtemp`, so no other call can guess its name. Isolation is by path, not by user: every
 * call in one process runs as the same OS user, so code that writes ELSEWHERE (`os.tmpdir()`
 * itself, a fixed path) is shared with every other call on the runner.
 */
export interface CallScratch {
  readonly dir: string;
  /** Removes the directory and everything in it. Idempotent; never rejects. */
  remove(): Promise<void>;
}

export interface CallScratchOptions {
  /** Where to create it. Default: the OS temp directory. */
  root?: string;
  log?: (message: string) => void;
}

/** Rejects, naming the directory and `TMPDIR`, when the directory cannot be created. */
export async function createCallScratch(options: CallScratchOptions = {}): Promise<CallScratch> {
  const root = options.root ?? tmpdir();
  const log = options.log ?? ((message: string) => console.error(message));
  let dir: string;
  try {
    dir = await mkdtemp(join(root, "curb-call-"));
  } catch (error) {
    throw new Error(
      `could not create this call's scratch directory under ${root}: ${describe(error)}. ` +
        `Point TMPDIR at a writable directory.`,
    );
  }

  let removing: Promise<void> | null = null;
  return {
    dir,
    remove: () => {
      removing ??= rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
        // KEEP-JUSTIFIED: the call has already ended and there is nobody left to answer.
        // Rejecting here would fail the end of a finished call; the leftover directory is
        // reported with its path, and the runner's own scratch volume dies with it.
        log(`curb: could not remove the scratch directory ${dir} of a finished call: ${describe(error)}`);
      });
      return removing;
    },
  };
}

/**
 * The call's scratch directory, or null when none could be created.
 *
 * Null rather than a failed call. KEEP-JUSTIFIED: a runner whose temp directory is not
 * writable served its calls before scratch directories existed, and failing every call over a
 * directory its agent may never use would take them all down. The failure is logged with its
 * cause, and the agent sees `useSession().call.scratchDir` absent rather than a path that does
 * not exist.
 */
export async function openCallScratch(
  callId: string,
  options: CallScratchOptions = {},
): Promise<CallScratch | null> {
  const log = options.log ?? ((message: string) => console.error(message));
  try {
    return await createCallScratch(options);
  } catch (error) {
    log(`curb: call ${callId} runs without a scratch directory: ${describe(error)}`);
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
