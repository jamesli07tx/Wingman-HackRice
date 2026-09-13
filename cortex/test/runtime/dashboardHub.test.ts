// DashboardHub per-user scoping: a session's events reach only the dashboards of the user who
// owns it; unbound / session-less events stay visible to everyone (restart tolerance).
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DashboardHub } from "../../src/dashboard/DashboardHub.js";

const silent = { info: () => undefined, warn: () => undefined };

async function connect(port: number, token: string): Promise<{ ws: WebSocket; got: unknown[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard?token=${token}`);
  const got: unknown[] = [];
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  return { ws, got };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

describe("DashboardHub per-user scoping", () => {
  const server = createServer();
  const hub = new DashboardHub({ verifyToken: async (t) => (t.startsWith("u_") ? t : null), logger: silent });
  hub.attach(server);
  afterEach(() => { hub.close(); server.close(); });

  it("routes a bound session only to its owner; unbound events go to all", async () => {
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const a = await connect(port, "u_a");
    const b = await connect(port, "u_b");

    hub.bindSession("s_a", "u_a");
    hub.emit({ type: "session", sessionId: "s_a", state: "started" });
    hub.emit({ type: "session", sessionId: "s_unbound", state: "started" });
    await tick();

    expect(a.got).toHaveLength(2);
    expect(b.got).toHaveLength(1);
    expect(b.got[0]).toMatchObject({ sessionId: "s_unbound" });

    // Backlog replay on connect is filtered the same way.
    const a2 = await connect(port, "u_a");
    const b2 = await connect(port, "u_b");
    await tick();
    expect(a2.got.map((e) => (e as { sessionId: string }).sessionId)).toEqual(["s_a", "s_unbound"]);
    expect(b2.got.map((e) => (e as { sessionId: string }).sessionId)).toEqual(["s_unbound"]);
    for (const c of [a, b, a2, b2]) c.ws.close();
  });
});
