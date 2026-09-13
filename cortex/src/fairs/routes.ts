// INTEGRATION: fairs/routes.ts — REST for the fair list import (ADDITIVE; the
// §4.1 routes in rest/routes.ts are untouched). Same Clerk bearer auth.
// IN:  console/src/components/fair/* (new files) via fairApi.ts
// OUT:
//   POST /api/fairs/imports/link   { url, fairName? }         -> 202 { import }
//                                  link unusable               -> 422 LinkFailure (console disables the link field)
//   POST /api/fairs/imports/image  multipart file (+ fairName) -> 202 { import } | 422 { error: "image_failed" }
//   GET  /api/fairs/imports                                    -> { imports }
//   GET  /api/fairs/imports/:importId                          -> { import } | 404
//   GET  /api/fairs/companies                                  -> { companies }   (rows tagged with a fair)
//   POST /api/fairs/reload                                     -> { corpusSize }  (rebuild the identify list by hand)
// WIRE: app.register(fairRoutes({ service, verifyToken })) in cortex/src/index.ts.

import multipart from "@fastify/multipart";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ClerkVerifier } from "../rest/routes.js";
import { sniffImageType } from "./extract.js";
import { errText } from "./fetchPage.js";
import type { FairImportService } from "./FairImportService.js";

/** Anthropic's per-image ceiling; larger uploads get a clear 413. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const LinkBody = z.object({
  url: z.string().min(1).max(2048),
  fairName: z.string().max(80).optional(),
});

function cleanName(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t.slice(0, 80) : null;
}

function isTextField(x: unknown): x is { type: "field"; value: unknown } {
  return typeof x === "object" && x !== null && (x as { type?: string }).type === "field";
}

export interface FairRoutesDeps {
  service: FairImportService;
  verifyToken: ClerkVerifier;
}

export function fairRoutes(deps: FairRoutesDeps): FastifyPluginAsync {
  const { service, verifyToken } = deps;

  /** Clerk auth guard — same shape as rest/routes.ts (not exported there). */
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
    // Plugin scope: this registration is independent of rest/routes.ts's.
    await app.register(multipart, { limits: { fileSize: IMAGE_MAX_BYTES, files: 1 } });

    app.post("/api/fairs/imports/link", async (req, reply) => {
      if (!(await requireUser(req, reply))) return;
      const parsed = LinkBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const result = await service.startFromLink(parsed.data.url.trim(), cleanName(parsed.data.fairName));
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply.code(202).send({ import: result.import });
    });

    app.post("/api/fairs/imports/image", async (req, reply) => {
      if (!(await requireUser(req, reply))) return;
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "missing_file" });
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        return reply.code(413).send({
          error: "image_failed",
          message: "That image is larger than 5 MB; upload a smaller screenshot",
        });
      }
      const mediaType = sniffImageType(buffer);
      if (!mediaType) {
        return reply.code(415).send({ error: "image_failed", message: "Upload a PNG, JPEG, WebP or GIF image" });
      }
      // Text fields sent BEFORE the file part are available here (fairApi.ts appends fairName first).
      const nameField = (file.fields as Record<string, unknown>).fairName;
      const fairName = cleanName(isTextField(nameField) ? nameField.value : undefined);
      const result = await service.startFromImage(
        { buffer, mediaType, filename: file.filename || "image" },
        fairName,
      );
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply.code(202).send({ import: result.import });
    });

    app.get("/api/fairs/imports", async (req, reply) => {
      if (!(await requireUser(req, reply))) return;
      return reply.send({ imports: service.list() });
    });

    app.get("/api/fairs/imports/:importId", async (req, reply) => {
      if (!(await requireUser(req, reply))) return;
      const { importId } = req.params as { importId: string };
      const imp = service.get(importId);
      if (!imp) return reply.code(404).send({ error: "not_found" });
      return reply.send({ import: imp });
    });

    app.get("/api/fairs/companies", async (req, reply) => {
      if (!(await requireUser(req, reply))) return;
      try {
        return reply.send({ companies: await service.companiesOnFile() });
      } catch (err) {
        return reply.code(503).send({ error: "db_unavailable", message: errText(err) });
      }
    });

    app.post("/api/fairs/reload", async (req, reply) => {
      if (!(await requireUser(req, reply))) return;
      try {
        return reply.send({ corpusSize: await service.reload() });
      } catch (err) {
        return reply.code(503).send({ error: "reload_failed", message: errText(err) });
      }
    });
  };
}
