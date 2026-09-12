// INTEGRATION: rest/routes.ts (DESIGN.md §4.1)
// IN:  Console (Next.js) HTTP calls with a Clerk JWT in `Authorization: Bearer …`;
//      plus ONE unauthenticated call — POST /api/devices/claim, whose credential is the
//      6-digit link code (GlassBridge has no Clerk session; that is what D9's code dance is for).
// OUT: the §4.1 DTOs from @wingman/shared, delegating all real work to the injected
//      ProfileServiceApi / ContextProvider / OrchestratorApi; devices + link_codes rows in Supabase.
// WIRE: await app.register(restRoutes({ supabase, profiles, context, orchestrator,
//         verifyToken: createClerkVerifier(process.env.CLERK_SECRET_KEY!) }));
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: glassbridge/Wingman/StatusView.swift — the link screen that types the
//   6-digit code and stores the returned deviceToken in Keychain.
// CONTRACT: DESIGN.md §4.1 — POST /api/devices/link-code (dashboard) and
//   POST /api/devices/claim (GlassBridge). Raw deviceToken is returned exactly ONCE;
//   only its sha256 is stored (devices.token_hash) and it is what /ws/device?token= checks.
// AT-INTEGRATION: run the code -> claim flow once end to end; confirm the device then
//   appears in GET /api/devices with the right deviceType and a fresh lastSeen.

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type {
  ClaimResponse,
  CompanySearchItem,
  DeviceInfo,
  DeviceType,
  LinkCodeResponse,
  ProfileLinks,
} from "@wingman/shared";
import type { ContextProvider, OrchestratorApi, ProfileServiceApi } from "../interfaces.js";

/** Verifies a Clerk session JWT and returns the Clerk `sub` (our userId), or null. */
export type ClerkVerifier = (token: string) => Promise<string | null>;

/** Link codes live 10 minutes (DESIGN.md §4.1). */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const RESUME_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Real Clerk verification (@clerk/backend). Kept behind the ClerkVerifier type so tests
 * and the outage drill can inject a stub — no network in unit tests.
 */
export function createClerkVerifier(secretKey: string): ClerkVerifier {
  return async (token: string) => {
    const { verifyToken } = await import("@clerk/backend");
    try {
      const payload = await verifyToken(token, { secretKey });
      return typeof payload.sub === "string" ? payload.sub : null;
    } catch {
      return null;
    }
  };
}

export interface RestDeps {
  supabase: SupabaseClient;
  profiles: ProfileServiceApi;
  context: ContextProvider;
  orchestrator: OrchestratorApi;
  verifyToken: ClerkVerifier;
}

const LinksBody = z.object({
  linkedin: z.string().optional(),
  x: z.string().optional(),
  github: z.string().optional(),
  website: z.string().optional(),
});
const ClaimBody = z.object({
  code: z.string(),
  deviceType: z.enum(["glasses_bridge", "phone_web"]),
  name: z.string().min(1).max(80),
});
const SelfClaimBody = z.object({ name: z.string().min(1).max(80) });
const SessionStartBody = z.object({ deviceId: z.string().min(1) });
const SessionStopBody = z.object({ sessionId: z.string().min(1) });
const OverrideBody = z.object({ companyId: z.string().min(1) });

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function newDeviceId(): string {
  return `d_${randomBytes(8).toString("hex")}`;
}

/** 32 random bytes, hex — returned to the device once and never stored in the clear. */
function newDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function restRoutes(deps: RestDeps): FastifyPluginAsync {
  const { supabase, profiles, context, orchestrator, verifyToken } = deps;

  /** Clerk auth guard: returns the userId, or answers 401 and returns null. */
  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      await reply.code(401).send({ error: "missing_token" });
      return null;
    }
    let userId: string | null = null;
    try {
      userId = await verifyToken(header.slice(7).trim());
    } catch {
      userId = null;
    }
    if (!userId) {
      await reply.code(401).send({ error: "invalid_token" });
      return null;
    }
    return userId;
  }

  return async (app) => {
    await app.register(multipart, { limits: { fileSize: RESUME_MAX_BYTES, files: 1 } });

    // --- Profile ----------------------------------------------------------

    // POST /api/profile/resume — multipart PDF -> { profile: ProfileSummary }
    app.post("/api/profile/resume", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "missing_file" });
      const pdf = await file.toBuffer();
      const profile = await profiles.parseResume(userId, pdf);
      return reply.send({ profile });
    });

    // PUT /api/profile/links
    app.put("/api/profile/links", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const parsed = LinksBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      await profiles.setLinks(userId, parsed.data as ProfileLinks);
      return reply.send({ ok: true });
    });

    // GET /api/profile
    app.get("/api/profile", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const { profile, links } = await profiles.getProfile(userId);
      return reply.send({ profile, links });
    });

    // --- Devices ----------------------------------------------------------

    // POST /api/devices/link-code — dashboard shows the 6 digits (D9).
    app.post("/api/devices/link-code", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = sixDigitCode();
        const { error } = await supabase
          .from("link_codes")
          .insert({ code, user_id: userId, expires_at: expiresAt });
        if (!error) {
          const body: LinkCodeResponse = { code, expiresAt };
          return reply.send(body);
        }
      }
      return reply.code(503).send({ error: "code_generation_failed" });
    });

    // POST /api/devices/claim — GlassBridge. UNAUTHENTICATED BY DESIGN: the one-time
    // 6-digit code is the credential (the device has no Clerk session — D9).
    app.post("/api/devices/claim", async (req, reply) => {
      const parsed = ClaimBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const { code, deviceType, name } = parsed.data;

      const { data, error } = await supabase
        .from("link_codes")
        .select("code, user_id, expires_at")
        .eq("code", code)
        .limit(1);
      if (error) return reply.code(503).send({ error: "db_unavailable" });
      const row = (data as Record<string, unknown>[] | null)?.[0];
      if (!row) return reply.code(400).send({ error: "invalid_code" });
      if (new Date(String(row.expires_at)).getTime() < Date.now()) {
        await supabase.from("link_codes").delete().eq("code", code);
        return reply.code(400).send({ error: "expired_code" });
      }

      const deviceId = newDeviceId();
      const deviceToken = newDeviceToken();
      const insert = await supabase.from("devices").insert({
        device_id: deviceId,
        user_id: String(row.user_id),
        device_type: deviceType satisfies DeviceType,
        name,
        token_hash: sha256(deviceToken),
        last_seen: new Date().toISOString(),
      });
      if (insert.error) return reply.code(503).send({ error: "db_unavailable" });
      await supabase.from("link_codes").delete().eq("code", code); // single use

      const body: ClaimResponse = { deviceId, deviceToken };
      return reply.send(body);
    });

    // POST /api/devices/self-claim — phone mode; idempotent per user (D9): the same
    // phone_web deviceId is reused, with a freshly minted token each call.
    app.post("/api/devices/self-claim", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const parsed = SelfClaimBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const deviceToken = newDeviceToken();
      const tokenHash = sha256(deviceToken);
      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from("devices")
        .select("device_id")
        .eq("user_id", userId)
        .eq("device_type", "phone_web")
        .limit(1);
      if (error) return reply.code(503).send({ error: "db_unavailable" });
      const existing = (data as Record<string, unknown>[] | null)?.[0];

      if (existing) {
        const deviceId = String(existing.device_id);
        const upd = await supabase
          .from("devices")
          .update({ name: parsed.data.name, token_hash: tokenHash, last_seen: now })
          .eq("device_id", deviceId);
        if (upd.error) return reply.code(503).send({ error: "db_unavailable" });
        const body: ClaimResponse = { deviceId, deviceToken };
        return reply.send(body);
      }

      const deviceId = newDeviceId();
      const ins = await supabase.from("devices").insert({
        device_id: deviceId,
        user_id: userId,
        device_type: "phone_web",
        name: parsed.data.name,
        token_hash: tokenHash,
        last_seen: now,
      });
      if (ins.error) return reply.code(503).send({ error: "db_unavailable" });
      const body: ClaimResponse = { deviceId, deviceToken };
      return reply.send(body);
    });

    // GET /api/devices
    app.get("/api/devices", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const { data, error } = await supabase
        .from("devices")
        .select("device_id, device_type, name, last_seen")
        .eq("user_id", userId)
        .order("last_seen", { ascending: false });
      if (error) return reply.code(503).send({ error: "db_unavailable" });
      const devices: DeviceInfo[] = ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
        deviceId: String(row.device_id),
        deviceType: (row.device_type === "phone_web" ? "phone_web" : "glasses_bridge") as DeviceType,
        name: String(row.name ?? ""),
        lastSeen: new Date(String(row.last_seen)).toISOString(),
      }));
      return reply.send(devices);
    });

    // --- Session ----------------------------------------------------------

    // POST /api/session/start
    app.post("/api/session/start", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const parsed = SessionStartBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const started = orchestrator.startForDevice(parsed.data.deviceId);
      if (!started) return reply.code(409).send({ error: "device_not_connected" });
      return reply.send(started);
    });

    // POST /api/session/stop
    app.post("/api/session/stop", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const parsed = SessionStopBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      orchestrator.stop(parsed.data.sessionId);
      return reply.send({ ok: true });
    });

    // POST /api/session/override — demo safety (D3/D4): force a company on the
    // single active session (D8 is single-user, so no sessionId is on the wire).
    app.post("/api/session/override", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const parsed = OverrideBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const active = orchestrator.activeSessionForUser();
      if (!active) return reply.code(409).send({ error: "no_active_session" });
      await orchestrator.override(active.sessionId, parsed.data.companyId);
      return reply.send({ ok: true });
    });

    // --- Companies (override picker) --------------------------------------

    // GET /api/companies?q=stri
    app.get("/api/companies", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const q = (req.query as { q?: string } | undefined)?.q ?? "";
      const results: CompanySearchItem[] = await context.search(q);
      return reply.send(results);
    });
  };
}
