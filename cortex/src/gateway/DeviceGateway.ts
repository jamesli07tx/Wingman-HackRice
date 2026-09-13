// INTEGRATION: DeviceGateway (DESIGN.md §5.3)
// IN:  device WebSocket connections at /ws/device?token=<deviceToken> carrying
//      DeviceToCortexMsg JSON text frames (DESIGN.md §4.2).
// OUT: one DeviceChannel per authenticated connection, plus GatewayEvents callbacks
//      (onDeviceSessionStart / onDeviceSessionStop / onFrame / onPhoto / onPhotoError /
//      onStatus / onDisconnect) — consumed by SessionOrchestrator.
// WIRE: const gw = new DeviceGateway({ supabase, events: orchestrator,
//         onChannelOpen: (ch) => orchestrator.registerChannel(ch) });
//       gw.attach(fastify.server)   // in cortex/src/index.ts, after app.listen/ready
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: glassbridge/Wingman/CortexSocket.swift (WS client + reconnect)
// CONTRACT: DESIGN.md §4.2 — device WebSocket, wss://…/ws/device?token=<deviceToken>
// AT-INTEGRATION: verify a `hello` with deviceType "glasses_bridge" arrives after link
//   (watch the cortex log line `device hello …` or the dashboard feed) — nothing to fill in here.
//
// Decoding is LENIENT per the merge contract (DESIGN_WINDOWS.md §0.4): unknown fields are
// ignored, unknown message types are logged and dropped, a malformed frame never kills the
// socket. Encoding is strict — we only ever send CortexToDeviceMsg shapes.

import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CortexToDeviceMsg,
  DeviceToCortexMsg,
  DeviceType,
  StatusMsg,
} from "@wingman/shared";
import { STALE_FRAME_MS } from "@wingman/shared";
import type { DeviceChannel, GatewayEvents } from "../interfaces.js";

export const DEVICE_WS_PATH = "/ws/device";

export interface GatewayLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: GatewayLogger = {
  // eslint-disable-next-line no-console
  info: (msg, meta) => console.log(`[gateway] ${msg}`, meta ?? ""),
  // eslint-disable-next-line no-console
  warn: (msg, meta) => console.warn(`[gateway] ${msg}`, meta ?? ""),
};

export interface DeviceGatewayDeps {
  /** Service-role Supabase client; used for devices.token_hash lookup + last_seen. */
  supabase: SupabaseClient;
  /** The orchestrator (or any GatewayEvents implementation). */
  events: GatewayEvents;
  /**
   * Additive seam (not in interfaces.ts): fires when an authenticated socket opens,
   * BEFORE any session_start. SessionOrchestrator uses it so a dashboard-initiated
   * POST /api/session/start can reach a device that has not started a session itself.
   */
  onChannelOpen?: (channel: DeviceChannel) => void;
  onChannelClose?: (deviceId: string) => void;
  logger?: GatewayLogger;
}

/** A device row as the gateway needs it (snake_case in Postgres, camelCase here). */
export interface DeviceAuthRecord {
  deviceId: string;
  userId: string;
  deviceType: DeviceType;
  name: string;
}

/** sha256 hex of a raw deviceToken — the only form ever stored (devices.token_hash). */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Lenient decode of a device text frame (DESIGN_WINDOWS.md §0.4).
 * Returns null for anything unusable; ignores unknown fields on known types.
 */
export function parseDeviceMessage(raw: string): DeviceToCortexMsg | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case "hello": {
      const deviceType = m.deviceType === "phone_web" ? "phone_web" : "glasses_bridge";
      const caps = (typeof m.caps === "object" && m.caps !== null ? m.caps : {}) as Record<string, unknown>;
      return {
        type: "hello",
        deviceType,
        caps: { video: caps.video !== false, photoHiRes: caps.photoHiRes === true },
      };
    }
    case "session_start":
      return { type: "session_start" };
    case "session_stop":
      return { type: "session_stop" };
    case "frame": {
      if (typeof m.dataBase64 !== "string") return null;
      return {
        type: "frame",
        seq: typeof m.seq === "number" ? m.seq : 0,
        ts: typeof m.ts === "number" ? m.ts : Date.now(),
        mime: "image/jpeg",
        dataBase64: m.dataBase64,
      };
    }
    case "photo": {
      if (typeof m.dataBase64 !== "string" || typeof m.reqId !== "string") return null;
      return { type: "photo", reqId: m.reqId, mime: "image/jpeg", dataBase64: m.dataBase64 };
    }
    case "photo_error": {
      if (typeof m.reqId !== "string") return null;
      return {
        type: "photo_error",
        reqId: m.reqId,
        reason: typeof m.reason === "string" ? m.reason : "unknown",
      };
    }
    case "status": {
      const out: StatusMsg = { type: "status" };
      if (typeof m.battery === "number") out.battery = m.battery;
      if (typeof m.note === "string") out.note = m.note;
      return out;
    }
    default:
      return null;
  }
}

/** One live device socket. MockDeviceAdapter is the hardware-free stand-in for this. */
class WsDeviceChannel implements DeviceChannel {
  #deviceType: DeviceType;

  constructor(
    readonly deviceId: string,
    readonly userId: string,
    deviceType: DeviceType,
    private readonly socket: WebSocket,
    private readonly logger: GatewayLogger,
  ) {
    this.#deviceType = deviceType;
  }

  get deviceType(): DeviceType {
    return this.#deviceType;
  }

  /** hello may refine the type the DB recorded at claim time (lenient decode). */
  setDeviceType(deviceType: DeviceType): void {
    this.#deviceType = deviceType;
  }

  send(msg: CortexToDeviceMsg): void {
    if (this.socket.readyState !== 1 /* OPEN */) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch (err) {
      this.logger.warn("send failed", { deviceId: this.deviceId, err: String(err) });
    }
  }

  close(): void {
    try {
      this.socket.close(1000, "cortex_close");
    } catch {
      /* already gone */
    }
  }
}

export class DeviceGateway {
  readonly #wss = new WebSocketServer({ noServer: true });
  readonly #channels = new Map<string, WsDeviceChannel>();
  readonly #logger: GatewayLogger;

  constructor(private readonly deps: DeviceGatewayDeps) {
    this.#logger = deps.logger ?? consoleLogger;
  }

  /** Attach to Fastify's raw HTTP server. Ignores upgrades for other paths. */
  attach(server: HttpServer): void {
    server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket as Duplex, head);
    });
  }

  /**
   * Returns true if this gateway owns the upgrade (path match), false if some other
   * handler (e.g. DashboardHub) should get it. Auth failures are answered with 401.
   */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== DEVICE_WS_PATH) return false;

    const token = url.searchParams.get("token");
    const device = token ? await this.#authenticate(token) : null;
    if (!device) {
      this.#logger.warn("device ws rejected (bad token)");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }

    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#onConnection(ws, device);
    });
    return true;
  }

  /** Live channel for a device, if connected (SessionOrchestrator/REST convenience). */
  channelFor(deviceId: string): DeviceChannel | undefined {
    return this.#channels.get(deviceId);
  }

  close(): void {
    for (const ch of this.#channels.values()) ch.close();
    this.#channels.clear();
    this.#wss.close();
  }

  async #authenticate(token: string): Promise<DeviceAuthRecord | null> {
    const tokenHash = hashDeviceToken(token);
    try {
      const { data, error } = await this.deps.supabase
        .from("devices")
        .select("device_id, user_id, device_type, name")
        .eq("token_hash", tokenHash)
        .limit(1);
      if (error) {
        this.#logger.warn("device lookup failed", { err: error.message });
        return null;
      }
      const row = (data as Record<string, unknown>[] | null)?.[0];
      if (!row) return null;
      return {
        deviceId: String(row.device_id),
        userId: String(row.user_id),
        deviceType: row.device_type === "phone_web" ? "phone_web" : "glasses_bridge",
        name: String(row.name ?? ""),
      };
    } catch (err) {
      this.#logger.warn("device lookup threw", { err: String(err) });
      return null;
    }
  }

  async #touchLastSeen(deviceId: string): Promise<void> {
    try {
      await this.deps.supabase
        .from("devices")
        .update({ last_seen: new Date().toISOString() })
        .eq("device_id", deviceId);
    } catch (err) {
      this.#logger.warn("last_seen update failed", { deviceId, err: String(err) });
    }
  }

  #onConnection(ws: WebSocket, device: DeviceAuthRecord): void {
    // One socket per device: a reconnect replaces the old channel.
    const previous = this.#channels.get(device.deviceId);
    if (previous) previous.close();

    const channel = new WsDeviceChannel(
      device.deviceId,
      device.userId,
      device.deviceType,
      ws,
      this.#logger,
    );
    this.#channels.set(device.deviceId, channel);
    this.#logger.info("device connected", {
      deviceId: device.deviceId,
      deviceType: device.deviceType,
    });
    void this.#touchLastSeen(device.deviceId);
    this.deps.onChannelOpen?.(channel);

    ws.on("message", (data: unknown) => {
      const raw =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : String(data);
      const msg = parseDeviceMessage(raw);
      if (!msg) {
        this.#logger.warn("dropped unparseable device message", { deviceId: device.deviceId });
        return;
      }
      this.#dispatch(channel, msg);
    });

    ws.on("close", () => {
      // A socket this device already replaced (see the top of #onConnection) must not
      // tear down the LIVE channel's session. Its close can land long after the swap —
      // ws waits 30 s for a close handshake the peer never answers, and through
      // CloudFront the old TCP leg lingers — which was ending fresh sessions with "error".
      if (this.#channels.get(device.deviceId) !== channel) {
        this.#logger.info("stale device socket closed", { deviceId: device.deviceId });
        return;
      }
      this.#channels.delete(device.deviceId);
      this.#logger.info("device disconnected", { deviceId: device.deviceId });
      this.deps.onChannelClose?.(device.deviceId);
      this.deps.events.onDisconnect(device.deviceId);
    });

    ws.on("error", (err: Error) => {
      this.#logger.warn("device socket error", { deviceId: device.deviceId, err: err.message });
    });
  }

  #dispatch(channel: WsDeviceChannel, msg: DeviceToCortexMsg): void {
    const { events } = this.deps;
    const deviceId = channel.deviceId;
    switch (msg.type) {
      case "hello":
        // X-MACHINE checkpoint: this is the line that proves GlassBridge linked.
        channel.setDeviceType(msg.deviceType);
        this.#logger.info("device hello", { deviceId, deviceType: msg.deviceType, caps: msg.caps });
        void this.#touchLastSeen(deviceId);
        break;
      case "session_start":
        events.onDeviceSessionStart(channel);
        break;
      case "session_stop":
        events.onDeviceSessionStop(deviceId);
        break;
      case "frame":
        // Stale-frame guard: a frame that queued behind a slow uplink may show a booth the wearer left.
        if (typeof msg.ts === "number" && Date.now() - msg.ts > STALE_FRAME_MS) {
          this.#logger.info("stale frame skipped", { deviceId, seq: msg.seq, ageMs: Date.now() - msg.ts });
          break;
        }
        events.onFrame(deviceId, msg.seq, Buffer.from(msg.dataBase64, "base64"));
        break;
      case "photo":
        events.onPhoto(deviceId, msg.reqId, Buffer.from(msg.dataBase64, "base64"));
        break;
      case "photo_error":
        events.onPhotoError(deviceId, msg.reqId, msg.reason);
        break;
      case "status":
        void this.#touchLastSeen(deviceId);
        events.onStatus(deviceId, msg.battery, msg.note);
        break;
    }
  }
}
