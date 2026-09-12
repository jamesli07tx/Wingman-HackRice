// Gateway decode/auth unit tests — no network, no Supabase, no LLM.
// The lenient-decoding rule is a merge-contract term (DESIGN_WINDOWS.md §0.4), so it is
// tested directly: unknown fields are ignored, unknown types dropped, a bad frame is
// never fatal.

import { describe, expect, it } from "vitest";
import { hashDeviceToken, parseDeviceMessage } from "../../src/gateway/DeviceGateway.js";

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

describe("hashDeviceToken", () => {
  it("is sha256 hex and stable (this is what devices.token_hash stores)", () => {
    expect(hashDeviceToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashDeviceToken("abc")).toBe(hashDeviceToken("abc"));
    expect(hashDeviceToken("abd")).not.toBe(hashDeviceToken("abc"));
  });
});
