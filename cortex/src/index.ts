// ORCHESTRATOR-OWNED bootstrap + DI wiring (DESIGN.md Appendix B, §7).
// Boot modes:
//   - full stack when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + CLERK_SECRET_KEY
//     are present (LLM calls additionally need ANTHROPIC_API_KEY at runtime);
//   - degraded /healthz-only otherwise, with an explicit log of what's missing
//     (keeps the hello-world deploy of build-order step 1 alive).
//   - MOCK_DEVICE=1 registers the fixture-replaying MockDeviceAdapter so the
//     whole pipeline runs with zero hardware (DESIGN_WINDOWS.md §1).

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createClient } from "@supabase/supabase-js";
import type { ProfileSummary } from "@wingman/shared";

import { DeviceGateway } from "./gateway/DeviceGateway.js";
import { MockDeviceAdapter } from "./gateway/MockDeviceAdapter.js";
import { SessionOrchestrator } from "./session/SessionOrchestrator.js";
import { DashboardHub } from "./dashboard/DashboardHub.js";
import { createClerkVerifier, restRoutes } from "./rest/routes.js";
import { SceneGate } from "./gate/SceneGate.js";
import { IdentifyService, type IdentifyCorpusEntry } from "./identify/IdentifyService.js";
import { ContextService, makeOpusSummarizer } from "./context/ContextService.js";
import { PitchService } from "./pitch/PitchService.js";
import { ScanService } from "./scan/ScanService.js";
import { ProfileService } from "./profile/ProfileService.js";

// Load the ROOT .env first (pnpm scripts run with cwd = cortex/, so a bare
// dotenv.config() would miss it), then cwd .env, then the local key-drop
// fallback env.template (gitignored). dotenv never overrides already-set vars,
// so this order = priority order.
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
dotenv.config();
dotenv.config({ path: fileURLToPath(new URL("../../env.template", import.meta.url)) });

const app = Fastify({ logger: true });

// The console always calls cortex cross-origin (localhost:3000 -> :8080 in dev,
// vercel.app -> fly.dev in prod). Auth is a bearer header, not cookies, so
// reflecting any origin is fine.
// methods must be explicit: the plugin's default allow-list omits PUT, which
// silently kills /api/profile/links behind a preflight rejection.
await app.register(cors, {
  origin: true,
  methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
});

app.get("/healthz", async () => ({
  ok: true,
  service: "wingman-cortex",
  version: "0.1.0",
}));

// Clerk is deliberately NOT in the boot gate: the mock/device pipeline runs
// without it; only REST + dashboard auth need it (they hard-reject when absent).
const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const missing = REQUIRED.filter((k) => !process.env[k]);

async function wireFullStack(): Promise<void> {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const clerkKey = process.env.CLERK_SECRET_KEY;
  if (!clerkKey) {
    app.log.warn(
      "CLERK_SECRET_KEY missing — REST and dashboard auth REJECT everything until it lands (device pipeline unaffected)",
    );
  }
  const verifyToken = clerkKey
    ? createClerkVerifier(clerkKey)
    : ((async () => {
        throw new Error("auth unavailable: CLERK_SECRET_KEY not set");
      }) as unknown as ReturnType<typeof createClerkVerifier>);
  const hub = new DashboardHub({ verifyToken, logger: app.log });

  // Identify corpus snapshot (boot-time; re-run `corpus ingest/enrich` + restart to refresh).
  const { data: corpusRows, error: corpusErr } = await supabase
    .from("companies")
    .select("company_id,name,aliases");
  if (corpusErr) app.log.warn({ err: corpusErr }, "corpus load failed — identify list is EMPTY");
  const corpus: IdentifyCorpusEntry[] = (corpusRows ?? []).map(
    (r: { company_id: string; name: string; aliases: string[] | null }) => ({
      companyId: r.company_id,
      name: r.name,
      aliases: r.aliases ?? [],
    }),
  );
  app.log.info({ companies: corpus.length }, "identify corpus loaded");

  const identifier = new IdentifyService(corpus);
  const context = new ContextService(supabase, fetch, makeOpusSummarizer(), {
    tavilyApiKey: process.env.TAVILY_API_KEY,
  });
  const pitch = new PitchService();
  const scan = new ScanService();
  const profiles = new ProfileService(supabase);

  // Single-user demo (D8): the profile is whichever row has a parsed summary.
  const getProfile = async (): Promise<ProfileSummary | null> => {
    const { data } = await supabase
      .from("profiles")
      .select("summary")
      .not("summary", "is", null)
      .limit(1)
      .maybeSingle();
    return (data?.summary as ProfileSummary | null) ?? null;
  };

  // SceneGate needs the orchestrator's detection handler; orchestrator needs the
  // gate. Break the cycle with a late-bound forwarder.
  let orchRef: SessionOrchestrator | undefined;
  const gate = new SceneGate(
    (sessionId, det) => orchRef?.onDetection(sessionId, det),
    (sessionId, seq, r) =>
      hub.emit({ type: "gate", sessionId, frameSeq: seq, class: r.class, orgHint: r.orgHint }),
  );
  const orchestrator = new SessionOrchestrator({
    gate,
    identifier,
    context,
    pitch,
    scan,
    getProfile,
    dashboard: hub,
    logger: app.log,
  });
  orchRef = orchestrator;

  const gateway = new DeviceGateway({
    supabase,
    events: orchestrator,
    onChannelOpen: (ch) => orchestrator.registerChannel(ch),
    onChannelClose: (deviceId) => orchestrator.unregisterChannel(deviceId),
    logger: app.log,
  });

  // ONE upgrade router (runtime-agent note #6): try each path handler, destroy
  // unmatched sockets instead of leaving them hanging.
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      if (await gateway.handleUpgrade(req, socket, head)) return;
      if (await hub.handleUpgrade(req, socket, head)) return;
      socket.destroy();
    })().catch(() => socket.destroy());
  });

  await app.register(restRoutes({ supabase, profiles, context, orchestrator, verifyToken }));

  if (process.env.MOCK_DEVICE === "1") {
    // INTEGRATION: fixture E2E — the whole pipeline with zero hardware.
    const mock = new MockDeviceAdapter({ events: orchestrator, logger: app.log });
    orchestrator.registerChannel(mock);
    app.addHook("onListen", async () => {
      await mock.start();
      app.log.info("MockDeviceAdapter replaying fixture walk");
    });
  }
}

const port = Number(process.env.PORT ?? 8080);

(async () => {
  if (missing.length > 0) {
    app.log.warn(
      { missing },
      "DEGRADED BOOT: /healthz only. Fill these in .env (or env.template) for the full stack.",
    );
  } else {
    await wireFullStack();
  }
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`cortex listening on :${port}`);
})().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
