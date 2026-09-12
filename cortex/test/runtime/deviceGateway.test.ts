// Gateway decode/auth unit tests — no network, no Supabase, no LLM.
// The lenient-decoding rule is a merge-contract term (DESIGN_WINDOWS.md §0.4), so it is
// tested directly: unknown fields are ignored, unknown types dropped, a bad frame is
// never fatal.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceGateway, hashDeviceToken, parseDeviceMessage } from "../../src/gateway/DeviceGateway.js";
import type { GatewayEvents } from "../../src/interfaces.js";
import { makeFakeSupabase } from "../services/fakes.js";

describe("parseDeviceMessage (lenient decode)", () => {
  it("accepts hello and ignores unknown fields", () => {
    const msg = parseDeviceMessage(
      JSON.stringify({
        type: "hello",
        deviceType: "glasses_bridge",
        caps: { video: true, photoHiRes: true, futureCap: "ignored" },
        firmware: "v125",
      }),
    );
    expect(msg).toEqual({
      type: "hello",
      deviceType: "glasses_bridge",
      caps: { video: true, photoHiRes: true },
    });
  });

  it("defaults an unknown deviceType to glasses_bridge rather than failing", () => {
    const msg = parseDeviceMessage(JSON.stringify({ type: "hello", deviceType: "holodeck" }));
    expect(msg).toMatchObject({ type: "hello", deviceType: "glasses_bridge" });
  });

  it("decodes frame / photo / photo_error / status", () => {
    const frame = parseDeviceMessage(
      JSON.stringify({ type: "frame", seq: 412, ts: 1757700000123, mime: "image/jpeg", dataBase64: "AAA" }),
    );
    expect(frame).toEqual({
      type: "frame",
      seq: 412,
      ts: 1757700000123,
      mime: "image/jpeg",
      dataBase64: "AAA",
    });

    expect(parseDeviceMessage(JSON.stringify({ type: "photo", reqId: "r_18", dataBase64: "BBB" }))).toEqual({
      type: "photo",
      reqId: "r_18",
      mime: "image/jpeg",
      dataBase64: "BBB",
    });

    expect(
      parseDeviceMessage(JSON.stringify({ type: "photo_error", reqId: "r_18", reason: "capture_failed" })),
    ).toEqual({ type: "photo_error", reqId: "r_18", reason: "capture_failed" });

    expect(parseDeviceMessage(JSON.stringify({ type: "status", battery: 0.61, note: "reconnected" }))).toEqual(
      { type: "status", battery: 0.61, note: "reconnected" },
    );
  });

  it("drops unknown types, malformed JSON and incomplete frames", () => {
    expect(parseDeviceMessage(JSON.stringify({ type: "voice_intent", text: "hi" }))).toBeNull();
    expect(parseDeviceMessage("{not json")).toBeNull();
    expect(parseDeviceMessage(JSON.stringify({ type: "frame", seq: 1 }))).toBeNull();
    expect(parseDeviceMessage(JSON.stringify("a string"))).toBeNull();
  });

  it("tolerates a frame missing seq/ts (lenient: fills defaults)", () => {
    const msg = parseDeviceMessage(JSON.stringify({ type: "frame", dataBase64: "AAA" }));
    expect(msg).toMatchObject({ type: "frame", seq: 0, mime: "image/jpeg", dataBase64: "AAA" });
  });
});

// Reconnect semantics over a real socket pair. The gateway keeps ONE channel per device;
// a reconnect replaces the old socket, whose close event may arrive much later (ws waits
// 30 s for an unanswered close handshake; CloudFront keeps the old leg alive). That late
// close must not be reported as the device disconnecting — it was ending live sessions.
describe("DeviceGateway reconnect", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  async function boot() {
    const supabase = makeFakeSupabase((table) =>
      table === "devices"
        ? { data: [{ device_id: "dev_1", user_id: "u_1", device_type: "glasses_bridge", name: "g" }], error: null }
        : { data: null, error: null },
    );
    const events: GatewayEvents = {
      onDeviceSessionStart: vi.fn(),
      onDeviceSessionStop: vi.fn(),
      onFrame: vi.fn(),
      onPhoto: vi.fn(),
      onPhotoError: vi.fn(),
      onStatus: vi.fn(),
      onDisconnect: vi.fn(),
    };
    const onChannelClose = vi.fn();
    const gateway = new DeviceGateway({
      supabase: supabase.client,
      events,
      onChannelClose,
      logger: { info: () => {}, warn: () => {} },
    });
    const server = createServer();
    gateway.attach(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    cleanups.push(() => {
      gateway.close();
      server.close();
    });
    const connect = () =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/device?token=t`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
    const closed = (ws: WebSocket) => new Promise<void>((r) => ws.once("close", () => r()));
    return { gateway, events, onChannelClose, connect, closed };
  }

  it("a replaced socket's late close does not disconnect the live channel", async () => {
    const { gateway, events, onChannelClose, connect, closed } = await boot();
    const first = await connect();
    const firstClosed = closed(first);
    const second = await connect();
    await firstClosed; // server closed the old socket when the new one arrived

    expect(gateway.channelFor("dev_1")).toBeDefined();
    expect(events.onDisconnect).not.toHaveBeenCalled();
    expect(onChannelClose).not.toHaveBeenCalled();

    const secondClosed = closed(second);
    second.close();
    await secondClosed;
    await vi.waitFor(() => expect(events.onDisconnect).toHaveBeenCalledTimes(1));
    expect(events.onDisconnect).toHaveBeenCalledWith("dev_1");
    expect(onChannelClose).toHaveBeenCalledTimes(1);
    expect(gateway.channelFor("dev_1")).toBeUndefined();
  });
});

describe("hashDeviceToken", () => {
  it("is sha256 hex and stable (this is what devices.token_hash stores)", () => {
    expect(hashDeviceToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashDeviceToken("abc")).toBe(hashDeviceToken("abc"));
    expect(hashDeviceToken("abd")).not.toBe(hashDeviceToken("abc"));
  });
});
