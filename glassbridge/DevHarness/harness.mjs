#!/usr/bin/env node
// harness.mjs — a fake Cortex for GlassBridge (DESIGN_MAC.md §1 "DevHarness"). Plain node + `ws`.
//   * POST /api/devices/claim  → { deviceId, deviceToken }   (code "000000" → 404, to exercise the error path)
//   * GET  /ws/device?token=…  → validates every device→cortex message against DESIGN.md §4.2 shapes, logs cadence
//                                and sizes, and replays the scripted card sequence after session_start.
// Shapes below are transcribed from DESIGN.md §4.2 — NEVER from cortex/ source (merge contract §0.2).
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: the real Cortex (cortex/src/index.ts on Fly.io) replaces this whole file on integration day
// CONTRACT: DESIGN.md §4.1 /api/devices/claim, §4.2 device WebSocket
// AT-INTEGRATION: INTEGRATION-DAY: nothing to change here — stop using it: turn off "Use DevHarness" in StatusView (or set a real CORTEX_WS_URL).
import http from "node:http";
import fs from "node:fs";
import { WebSocketServer } from "ws";

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const PORT = Number(process.env.PORT ?? arg("--port", 8787));
const CONFIG = { frameIntervalMs: Number(arg("--interval", 1750)), frameMaxEdgePx: 768, docMaxEdgePx: 2048, renderMinGapMs: 500 }; // DESIGN.md Appendix D
const END_SEC = Number(arg("--end", 90));
const BURST = process.argv.includes("--burst");
const SAVE = process.argv.includes("--save");
if (SAVE) fs.mkdirSync("frames", { recursive: true });

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

// ---- DESIGN.md §4.2 device → cortex shapes: required keys and their JS types ----
const SHAPES = {
  hello: { deviceType: "string", caps: "object" },
  session_start: {},
  session_stop: {},
  frame: { seq: "number", ts: "number", mime: "string", dataBase64: "string" },
  photo: { reqId: "string", mime: "string", dataBase64: "string" },
  photo_error: { reqId: "string", reason: "string" },
  status: {},
};
function validate(msg) {
  const shape = SHAPES[msg.type];
  if (!shape) return `unknown type ${msg.type}`;
  for (const [k, t] of Object.entries(shape)) if (typeof msg[k] !== t) return `${msg.type}.${k} should be ${t}, got ${typeof msg[k]}`;
  if (msg.type === "hello" && !["glasses_bridge", "phone_web"].includes(msg.deviceType)) return `bad deviceType ${msg.deviceType}`;
  if ((msg.type === "frame" || msg.type === "photo") && msg.mime !== "image/jpeg") return `mime must be image/jpeg`;
  if (msg.type === "status" && msg.battery != null && (typeof msg.battery !== "number" || msg.battery < 0 || msg.battery > 1)) return `battery must be 0..1`;
  return null;
}

// ---- DESIGN.md §4.2 example cards, verbatim ----
const company = (seq, page, extraLines = []) => ({
  cardId: "c_007", seq, kind: "company", title: "Stripe",
  subtitle: "Payments infrastructure for the internet",
  lines: ["Hiring: SWE Intern, New Grad Backend", "Stack: Ruby, Go, ML infra at scale", "Recently: launched usage-based billing APIs", ...extraLines].slice(0, 5),
  footer: `Wingman · ${page}/2`, page: { index: page, count: 2 }, streaming: false,
  company: { companyId: "stripe", confidence: 0.93 }, minDisplaySec: 15,
});
const pitch = (seq) => ({
  cardId: "c_007", seq, kind: "pitch", title: "Stripe", subtitle: "Your pitch",
  lines: ["Built telemetry pipeline at Guadaloop", "Ask about usage-based billing infra", "TypeScript + Go — matches their stack"],
  footer: "Wingman · 2/2", page: { index: 2, count: 2 }, streaming: false, company: { companyId: "stripe", confidence: 0.93 },
});

// ---- HTTP: claim endpoint (DESIGN.md §4.1) ----
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/devices/claim") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let j = {}; try { j = JSON.parse(body); } catch {}
      log("claim", body);
      if (!/^\d{6}$/.test(j.code ?? "") || j.code === "000000") { res.writeHead(404, { "content-type": "application/json" }); return res.end(`{"error":"code not found"}`); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ deviceId: "dev_harness", deviceToken: "harness-token" }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

// ---- WS: device endpoint (DESIGN.md §4.2) ----
const wss = new WebSocketServer({ server, path: "/ws/device" });
wss.on("connection", (ws, req) => {
  const token = new URL(req.url, "http://x").searchParams.get("token");
  log(`WS connected token=${token ?? "MISSING"} from ${req.socket.remoteAddress}`);
  if (!token) { log("✗ no token → closing 4401"); return ws.close(4401, "missing token"); }

  let seq = 10, lastFrameAt = 0, frames = 0, timers = [], armed = false;
  const send = (m) => { ws.send(JSON.stringify(m)); log("→", m.type, m.card ? `${m.card.kind} ${m.card.cardId}#${m.card.seq} "${m.card.title}"` : m.reqId ?? m.sessionId ?? m.reason ?? ""); };
  const render = (card) => send({ type: "render", card });
  const at = (sec, fn) => timers.push(setTimeout(fn, sec * 1000));
  const endSession = (reason) => { timers.forEach(clearTimeout); timers = []; if (armed) { armed = false; send({ type: "session_end", reason }); } };

  const script = () => {
    at(1, () => render({ cardId: "c_007", seq: ++seq, kind: "ack", title: "Identifying…", footer: "Wingman" }));
    at(4, () => render(company(++seq, 1)));
    at(10, () => render(pitch(++seq)));
    at(16, () => render(company(++seq, 1)));                                  // rotation: same cardId, higher seq
    at(20, () => send({ type: "capture_photo", reqId: "r_18", quality: "document" }));
    at(26, () => send({ type: "error", code: "search_down", message: "harness: sample recoverable error", recoverable: true }));
    // burst lands at t=30, but never at/after END_SEC (a short --end would otherwise cut it off); its five
    // timers go in `timers` so endSession/close cancels any still pending (no send-after-close).
    if (BURST) at(Math.max(0, Math.min(30, END_SEC - 3)), () => { for (let i = 0; i < 5; i++) timers.push(setTimeout(() => render({ cardId: "burst", seq: i + 1, kind: "hint", title: `Burst ${i + 1}/5`, lines: ["≤ 1 replace per 500 ms", "last card wins"] }), i * 40)); });
    let page = 2;
    for (let t = 28; t < END_SEC; t += 12) at(t, () => { render(page === 2 ? pitch(++seq) : company(++seq, 1)); page = page === 2 ? 1 : 2; });
    at(END_SEC, () => endSession("user_stop"));
  };

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return log("✗ non-JSON frame"); }
    const err = validate(msg);
    if (err) return log(`✗ INVALID ${msg.type ?? "?"}: ${err}`);
    switch (msg.type) {
      case "hello": log(`✓ hello ${msg.deviceType} caps=${JSON.stringify(msg.caps)}`); break;
      case "session_start":
        log("✓ session_start → armed"); armed = true; frames = 0; lastFrameAt = 0;
        send({ type: "armed", sessionId: "s_42", config: CONFIG }); script(); break;
      case "session_stop": log("✓ session_stop"); endSession("user_stop"); break;
      case "frame": {
        const bytes = Buffer.from(msg.dataBase64, "base64");
        const gap = lastFrameAt ? `${Date.now() - lastFrameAt} ms since last` : "first";
        lastFrameAt = Date.now(); frames++;
        const ok = bytes[0] === 0xff && bytes[1] === 0xd8;
        log(`${ok ? "✓" : "✗"} frame seq=${msg.seq} ${(bytes.length / 1024).toFixed(1)} KB${bytes.length > 120 * 1024 ? " (>120 KB target!)" : ""} ${gap}${ok ? "" : " NOT A JPEG"}`);
        if (SAVE) fs.writeFileSync(`frames/frame-${String(msg.seq).padStart(5, "0")}.jpg`, bytes);
        break;
      }
      case "photo": {
        const bytes = Buffer.from(msg.dataBase64, "base64");
        log(`✓ photo reqId=${msg.reqId} ${(bytes.length / 1024).toFixed(1)} KB`);
        if (SAVE) fs.writeFileSync(`frames/photo-${msg.reqId}.jpg`, bytes);
        render(company(++seq, 1, ["Roles: SWE Intern (Summer 2027)", "Deadline: Oct 15"]));   // scan merge
        break;
      }
      case "photo_error": log(`✓ photo_error reqId=${msg.reqId} reason=${msg.reason}`); break;
      case "status": log(`✓ status battery=${msg.battery ?? "-"} note=${msg.note ?? "-"}`); break;
    }
  });
  ws.on("close", (code) => { log(`WS closed ${code} after ${frames} frames`); timers.forEach(clearTimeout); });
});

server.listen(PORT, () => log(`DevHarness listening: ws://localhost:${PORT}/ws/device  http://localhost:${PORT}/api/devices/claim  config=${JSON.stringify(CONFIG)}${BURST ? " --burst" : ""}${SAVE ? " --save" : ""}`));
