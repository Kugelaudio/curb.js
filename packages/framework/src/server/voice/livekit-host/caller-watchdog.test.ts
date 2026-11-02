import { describe, expect, it, vi } from "vitest";
import { EMPTY_ROOM_GRACE_MS, createCallerWatchdog } from "./caller-watchdog.js";

/**
 * A fake clock. Timers fire when the test says so, so these run instantly and
 * deterministically rather than waiting out a real sixty-second deadline.
 */
function clock() {
  const pending = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  let now = 0;
  return {
    setTimer(fn: () => void, ms: number) {
      const id = next++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(handle: unknown) {
      pending.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.fn();
        }
      }
    },
    get armed() {
      return pending.size;
    },
  };
}

function watchdog(remoteCount: () => number, emptyRoomMs = 15_000, noCallerMs = 60_000) {
  const time = clock();
  const ended: string[] = [];
  const logged: string[] = [];
  const dog = createCallerWatchdog({
    remoteCount,
    giveUp: () => ended.push("ended"),
    log: (message) => logged.push(message),
    emptyRoomMs,
    noCallerMs,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  return { dog, time, ended, logged };
}

describe("createCallerWatchdog", () => {
  it("ends the call when a caller never arrives", () => {
    // THE DEFECT THIS EXISTS FOR. Five hosted runners were found alive after 5 to 9 minutes,
    // each having joined its room with no participant ever connecting. The old rule armed
    // only on disconnect, and a caller who never connects never disconnects.
    let remote = 0
    const { dog, time, ended, logged } = watchdog(() => remote)

    dog.armForArrival()
    time.advance(59_000)
    expect(ended).toEqual([])

    time.advance(2_000)
    expect(ended).toEqual(["ended"])
    expect(logged[0]).toContain("no caller ever joined")
  })

  it("waits longer for an arrival than for a return", () => {
    // A browser negotiating ICE can take several seconds. Applying the short post-disconnect
    // grace to the initial wait would hang up on a slow join.
    let remote = 0
    const { dog, time, ended } = watchdog(() => remote)

    dog.armForArrival()
    time.advance(20_000) // past the empty-room grace, well short of the arrival one
    expect(ended).toEqual([])
  })

  it("a caller who joins cancels the arrival deadline", () => {
    let remote = 0
    const { dog, time, ended } = watchdog(() => remote)

    dog.armForArrival()
    remote = 1
    dog.onParticipantJoined()
    time.advance(120_000)

    expect(ended).toEqual([])
  })

  it("ends shortly after the last caller leaves", () => {
    let remote = 1
    const { dog, time, ended, logged } = watchdog(() => remote)

    dog.armForArrival() // no-op: somebody is already here
    remote = 0
    dog.onParticipantLeft()

    time.advance(14_000)
    expect(ended).toEqual([])
    time.advance(2_000)
    expect(ended).toEqual(["ended"])
    expect(logged[0]).toContain("no caller for")
  })

  it("keeps the call when somebody is still in the room", () => {
    let remote = 2
    const { dog, time, ended } = watchdog(() => remote)

    remote = 1
    dog.onParticipantLeft()
    time.advance(120_000)

    expect(ended).toEqual([])
  })

  it("does not end a call somebody rejoined during the grace", () => {
    // The race the firing-time re-check exists for: a rejoin lands after the timer was
    // armed, and the timer must notice rather than act on what was true when it started.
    let remote = 1
    const { dog, time, ended } = watchdog(() => remote)

    remote = 0
    dog.onParticipantLeft()
    remote = 1 // came back, without the join handler having run yet
    time.advance(20_000)

    expect(ended).toEqual([])
  })

  it("ends once, not once per event", () => {
    let remote = 0
    const { dog, time, ended } = watchdog(() => remote)

    dog.armForArrival()
    time.advance(120_000)
    dog.onParticipantLeft()
    time.advance(120_000)

    expect(ended).toEqual(["ended"])
  })

  it("stops watching once cancelled", () => {
    let remote = 0
    const { dog, time, ended } = watchdog(() => remote)

    dog.armForArrival()
    dog.cancel()
    time.advance(120_000)

    expect(ended).toEqual([])
  })
})

describe("a hosted caller's reconnect window", () => {
  // PLATFORM_SESSION_RECONNECT_GRACE's default: the platform keeps a dropped call this long.
  const PLATFORM_RECONNECT_GRACE_MS = 30_000;

  it("is still in the room when a caller rejoins as late as the platform allows", () => {
    const time = clock();
    const giveUp = vi.fn();
    const watchdog = createCallerWatchdog({
      remoteCount: () => 0,
      giveUp,
      log: () => {},
      emptyRoomMs: EMPTY_ROOM_GRACE_MS,
      noCallerMs: 60_000,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });

    watchdog.onParticipantLeft();
    time.advance(PLATFORM_RECONNECT_GRACE_MS);

    expect(giveUp).not.toHaveBeenCalled();
  });

  it("tells the host the last caller left, once per departure, and the call can still come back", () => {
    let remote = 1;
    const gone = vi.fn();
    const time = clock();
    const ended: string[] = [];
    const dog = createCallerWatchdog({
      remoteCount: () => remote,
      giveUp: () => ended.push("ended"),
      onCallerGone: gone,
      log: () => {},
      emptyRoomMs: EMPTY_ROOM_GRACE_MS,
      noCallerMs: 60_000,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });

    dog.onParticipantLeft();
    expect(gone).not.toHaveBeenCalled();

    remote = 0;
    dog.onParticipantLeft();
    expect(gone).toHaveBeenCalledOnce();
    expect(ended).toEqual([]);

    remote = 1;
    dog.onParticipantJoined();
    time.advance(EMPTY_ROOM_GRACE_MS);
    expect(ended).toEqual([]);
  });
});
