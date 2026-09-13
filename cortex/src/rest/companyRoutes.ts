// companyRoutes — the signed-in user's own company briefs (ADDITIVE; §4.1 routes untouched).
//   GET    /api/me/companies                 -> { companies: MyCompany[] }   (shared list, own edits merged)
//   PUT    /api/me/companies/:companyId      { name, card } -> { company }   (card = C3 SummaryCardContent)
//   POST   /api/me/companies                 { name, card } -> { company }   (a company not on file; id = slug)
//   DELETE /api/me/companies/:companyId      -> { ok }                       (back to the shared card)
// Same Clerk bearer as rest/routes.ts. WIRE: app.register(companyRoutes({ cards, verifyToken })).
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { SummaryCardSchema } from "@wingman/shared";
import type { UserCardService } from "../profile/UserCardService.js";
import type { ClerkVerifier } from "./routes.js";

const Body = z.object({ name: z.string().trim().min(1).max(80), card: SummaryCardSchema });

export function companyRoutes(deps: { cards: UserCardService; verifyToken: ClerkVerifier }): FastifyPluginAsync {
  const { cards, verifyToken } = deps;
  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      await reply.code(401).send({ error: "missing_token" });
      return null;
    }
    let userId: string | null = null;
    try { userId = await verifyToken(header.slice(7).trim()); } catch { userId = null; }
    if (!userId) {
      await reply.code(401).send({ error: "invalid_token" });
      return null;
    }
    return userId;
  }

  return async (app) => {
    app.get("/api/me/companies", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      return reply.send({ companies: await cards.list(userId) });
    });

    const save = async (req: FastifyRequest, reply: FastifyReply, companyId: string | null) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      const parsed = Body.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", message: parsed.error.issues[0]?.message });
      return reply.send({ company: await cards.set(userId, companyId, parsed.data.name, parsed.data.card) });
    };
    app.post("/api/me/companies", (req, reply) => save(req, reply, null));
    app.put("/api/me/companies/:companyId", (req, reply) =>
      save(req, reply, (req.params as { companyId: string }).companyId));

    app.delete("/api/me/companies/:companyId", async (req, reply) => {
      const userId = await requireUser(req, reply);
      if (!userId) return;
      await cards.remove(userId, (req.params as { companyId: string }).companyId);
      return reply.send({ ok: true });
    });
  };
}
