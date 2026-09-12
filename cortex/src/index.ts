// ORCHESTRATOR-OWNED bootstrap + DI wiring (DESIGN.md Appendix B).
// Currently: deployable hello-world (build-order step 1) with health check.
// INTEGRATION-DAY: wire the real modules here once subagents land them —
//   DeviceGateway(ws) + MockDeviceAdapter, SceneGate, IdentifyService,
//   ContextService, PitchService, ScanService, ProfileService,
//   SessionOrchestrator, DashboardHub, rest routes. Constructor injection
//   only, per DESIGN.md §7 (poor-man's DI).

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";

// Load root .env when present (deploys); fall back to the local key drop
// env.template (gitignored — was exposed once, keys being rotated). Tooling on
// this machine cannot write .env directly, hence the fallback.
dotenv.config();
dotenv.config({ path: fileURLToPath(new URL("../../env.template", import.meta.url)) });

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({
  ok: true,
  service: "wingman-cortex",
  version: "0.1.0",
}));

const port = Number(process.env.PORT ?? 8080);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`cortex listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
