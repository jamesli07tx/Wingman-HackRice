// MockDeviceAdapter replay test — the no-hardware rig (DESIGN_WINDOWS.md §1).
// Reads the real checked-in fixtures; no network, no Supabase, no LLM.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CortexToDeviceMsg } from "@wingman/shared";
import { FRAME_INTERVAL_MS } from "@wingman/shared";
import { MockDeviceAdapter } from "../../src/gateway/MockDeviceAdapter.js";
import type { DeviceChannel, GatewayEvents } from "../../src/interfaces.js";

const silentLogger = { info: () => undefined };

function recorder() {
  const frames: { seq: number; bytes: number }[] = [];
  const photos: { reqId: string; bytes: number }[] = [];
  const started: DeviceChannel[] = [];
  const events: GatewayEvents = {
    onDeviceSessionStart: (ch) => started.push(ch),
    onDeviceSessionStop: () => undefined,
    onFrame: (_id, seq, jpeg) => frames.push({ seq, bytes: jpeg.byteLength }),
    onPhoto: (_id, reqId, jpeg) => photos.push({ reqId, bytes: jpeg.byteLength }),
    onPhotoError: () => undefined,
    onStatus: () => undefined,
    onDisconnect: () => undefined,
  };
  return { events, frames, photos, started };
}

describe("MockDeviceAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("replays the canned walk: nothing x3 -> banner x3 -> nothing x2 -> document x2", async () => {
    const { events, frames, started } = recorder();
    const mock = new MockDeviceAdapter({ events, logger: silentLogger });
    await mock.start();

    expect(started).toHaveLength(1);
    expect(started[0]).toBe(mock);
    expect(mock.fixtures.map((f) => f.cls)).toEqual([
      "nothing",
      "nothing",
      "nothing",
      "banner",
      "banner",
      "banner",
      "nothing",
      "nothing",
      "document",
      "document",
    ]);

    await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS * 10);
    expect(frames).toHaveLength(10);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(frames.every((f) => f.bytes > 1000)).toBe(true);

    // Replay stops after the walk unless loop is set.
    await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS * 5);
    expect(frames).toHaveLength(10);
  });

  it("logs every CortexToDeviceMsg it receives and answers capture_photo with the document fixture", async () => {
    const { events, photos } = recorder();
    const logged: string[] = [];
    const mock = new MockDeviceAdapter({
      events,
      logger: { info: (m) => logged.push(m) },
      intervalMs: 10,
    });
    await mock.start();

    const messages: CortexToDeviceMsg[] = [
      { type: "armed", sessionId: "s_1", config: { frameIntervalMs: 1750, frameMaxEdgePx: 768, docMaxEdgePx: 2048, renderMinGapMs: 500 } },
      { type: "render", card: { cardId: "c_1", seq: 1, kind: "ack", title: "Identifying…" } },
      { type: "capture_photo", reqId: "r_1", quality: "document" },
      { type: "error", code: "gate_down", message: "x", recoverable: true },
      { type: "session_end", reason: "user_stop" },
    ];
    for (const m of messages) mock.send(m);

    expect(mock.sent).toEqual(messages);
    for (const m of messages) expect(logged).toContain(`<- ${m.type}`);

    // capture_photo is answered with the last `document` fixture, so the scan path
    // is exercisable with zero hardware.
    expect(photos).toEqual([{ reqId: "r_1", bytes: expect.any(Number) }]);
    expect(photos[0]!.bytes).toBeGreaterThan(1000);
  });

  it("close() stops replay and reports a disconnect", async () => {
    const { events, frames } = recorder();
    let disconnected = 0;
    const mock = new MockDeviceAdapter({
      events: { ...events, onDisconnect: () => (disconnected += 1) },
      logger: silentLogger,
      intervalMs: 100,
    });
    await mock.start();
    await vi.advanceTimersByTimeAsync(250);
    const seen = frames.length;
    expect(seen).toBeGreaterThan(0);

    mock.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(frames).toHaveLength(seen);
    expect(disconnected).toBe(1);
  });
});
