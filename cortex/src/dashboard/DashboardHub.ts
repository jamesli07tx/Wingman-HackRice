// INTEGRATION: DashboardHub (DESIGN.md §4.3)
// IN:  DashboardEvent values from SessionOrchestrator (render / status / silenced_identify /
//      session) and from SceneGate's telemetry handler (gate) — via the DashboardFeed interface.
// OUT: the same JSON, broadcast to every browser connected at
//      /ws/dashboard?token=<Clerk JWT>. READ-ONLY: anything a dashboard sends is ignored.
// WIRE: const hub = new DashboardHub({ verifyToken: createClerkVerifier(process.env.CLERK_SECRET_KEY!) });
//       hub.attach(fastify.server);        // in cortex/src/index.ts
//       new SessionOrchestrator({ …, dashboard: hub });
//       new SceneGate(…, (sid, seq, r) => hub.emit({ type: "gate", sessionId: sid, frameSeq: seq, ...r }));
//
// This is the operator's mission-control view — notably the one place sub-threshold
// identifications the lens silenced (D13) become visible, so the operator knows to override.

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { DashboardEvent } from "@wingman/shared";
import type { DashboardFeed } from "../interfaces.js";

export const DASHBOARD_WS_PATH = "/ws/dashboard";

/** Verifies a Clerk session JWT and returns the Clerk `sub` (userId), or null. */
export type TokenVerifier = (token: string) => Promise<string | null>;

export interface DashboardLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: DashboardLogger = {
  // eslint-disable-next-line no-console
  info: (msg, meta) => console.log(`[dashboard] ${msg}`, meta ?? ""),
  // eslint-disable-next-line no-console
  warn: (msg, meta) => console.warn(`[dashboard] ${msg}`, meta ?? ""),
};

export interface DashboardHubDeps {
  /** Same verifier the REST layer uses (rest/routes.ts createClerkVerifier). */
  verifyToken: TokenVerifier;
  logger?: DashboardLogger;
  /** Replay this many recent events to a newly connected dashboard (default 50). */
  backlogSize?: number;
}

export class DashboardHub implements DashboardFeed {
  readonly #wss = new WebSocketServer({ noServer: true });
  readonly #clients = new Set<WebSocket>();
  readonly #backlog: DashboardEvent[] = [];
  readonly #log: DashboardLogger;
  readonly #backlogSize: number;

  constructor(private readonly deps: DashboardHubDeps) {
    this.#log = deps.logger ?? consoleLogger;
    this.#backlogSize = deps.backlogSize ?? 50;
  }

  attach(server: HttpServer): void {
    server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket as Duplex, head);
    });
  }

  /** True if this hub owns the upgrade (path match); false to let another handler try. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== DASHBOARD_WS_PATH) return false;

    const token = url.searchParams.get("token");
    const userId = token ? await this.#verify(token) : null;
    if (!userId) {
      this.#log.warn("dashboard ws rejected (bad Clerk token)");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }

    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, userId));
    return true;
  }

  /** DashboardFeed — fan out one event to every connected dashboard. */
  emit(event: DashboardEvent): void {
    this.#backlog.push(event);
    if (this.#backlog.length > this.#backlogSize) this.#backlog.shift();
    if (this.#clients.size === 0) return;
    const payload = JSON.stringify(event);
    for (const ws of this.#clients) {
      if (ws.readyState !== 1 /* OPEN */) continue;
      try {
        ws.send(payload);
      } catch (err) {
        this.#log.warn("dashboard send failed", { err: String(err) });
      }
    }
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  close(): void {
    for (const ws of this.#clients) {
      try {
        ws.close(1000, "cortex_close");
      } catch {
        /* already gone */
      }
    }
    this.#clients.clear();
    this.#wss.close();
  }

  async #verify(token: string): Promise<string | null> {
    try {
      return await this.deps.verifyToken(token);
    } catch (err) {
      this.#log.warn("clerk verify threw", { err: String(err) });
      return null;
    }
  }

  #onConnection(ws: WebSocket, userId: string): void {
    this.#clients.add(ws);
    this.#log.info("dashboard connected", { userId, clients: this.#clients.size });
    for (const event of this.#backlog) {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        break;
      }
    }
    // Read-only mirror: inbound dashboard frames are deliberately ignored.
    ws.on("message", () => undefined);
    ws.on("close", () => {
      this.#clients.delete(ws);
      this.#log.info("dashboard disconnected", { clients: this.#clients.size });
    });
    ws.on("error", (err: Error) => {
      this.#log.warn("dashboard socket error", { err: err.message });
      this.#clients.delete(ws);
    });
  }
}
