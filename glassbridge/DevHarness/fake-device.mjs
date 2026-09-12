#!/usr/bin/env node
// fake-device.mjs — a scripted GlassBridge stand-in to exercise harness.mjs (and, on integration day, the
// real Cortex) without a phone: hello → session_start → one tiny JPEG frame per 1750 ms → answers capture_photo.
import WebSocket from "ws";

const URL_ = process.argv[2] ?? "ws://localhost:8787/ws/device";
const TOKEN = process.argv[3] ?? "harness-token";
// 1×1 white JPEG
const JPEG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const ws = new WebSocket(`${URL_}?token=${TOKEN}`);
const send = (m) => { ws.send(JSON.stringify(m)); log("→", m.type, m.seq ?? m.reqId ?? ""); };
let seq = 0, timer;
ws.on("open", () => {
  send({ type: "hello", deviceType: "glasses_bridge", caps: { video: true, photoHiRes: true } });
  send({ type: "session_start" });
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "armed") { log("← armed", m.sessionId, JSON.stringify(m.config)); send({ type: "status", battery: 0.61, note: "fake" }); clearInterval(timer); timer = setInterval(() => send({ type: "frame", seq: ++seq, ts: Date.now(), mime: "image/jpeg", dataBase64: JPEG }), m.config?.frameIntervalMs ?? 1750); }
  else if (m.type === "render") log("← render", m.card.kind, `${m.card.cardId}#${m.card.seq}`, JSON.stringify([m.card.title, m.card.subtitle, ...(m.card.lines ?? []), m.card.footer].filter(Boolean)));
  else if (m.type === "capture_photo") send({ type: "photo", reqId: m.reqId, mime: "image/jpeg", dataBase64: JPEG });
  else if (m.type === "session_end") { log("← session_end", m.reason); clearInterval(timer); ws.close(); }
  else log("←", m.type, JSON.stringify(m));
});
ws.on("close", (c) => { log("closed", c); process.exit(0); });
ws.on("error", (e) => { log("error", e.message); process.exit(1); });
