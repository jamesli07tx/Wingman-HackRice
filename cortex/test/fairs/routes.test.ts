// REST surface of the fair list import: Clerk bearer guard, body validation,
// link-failure passthrough (what the console keys its "disable the link field"
// behaviour on), multipart image upload with the fairName field, status reads.

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { FairImportService } from "../../src/fairs/FairImportService.js";
import { fairRoutes } from "../../src/fairs/routes.js";
import type { FairImport } from "../../src/fairs/types.js";

const IMPORT: FairImport = {
  importId: "imp_1",
  fairName: "HackRice 16",
  source: "link",
  sourceRef: "https://hackrice.com/",
  status: "enriching",
  createdAt: "2026-09-12T00:00:00.000Z",
  finishedAt: null,
  companies: [{ name: "MathWorks", aliases: [], companyId: null, status: "pending", note: null }],
  done: 0,
  total: 1,
  reloaded: false,
  corpusSize: null,
  error: null,
};

function build(service: Partial<Record<keyof FairImportService, unknown>> = {}) {
  const app = Fastify();
  const verifyToken = vi.fn(async (token: string) => (token === "good" ? "user_1" : null));
  const svc = {
    startFromLink: vi.fn(async () => ({ ok: true, import: IMPORT })),
    startFromImage: vi.fn(async () => ({ ok: true, import: { ...IMPORT, source: "image", sourceRef: "roster.png" } })),
    list: vi.fn(() => [IMPORT]),
    get: vi.fn((id: string) => (id === "imp_1" ? IMPORT : null)),
    companiesOnFile: vi.fn(async () => []),
    reload: vi.fn(async () => 42),
    ...service,
  };
  void app.register(fairRoutes({ service: svc as unknown as FairImportService, verifyToken }));
  return { app, svc, verifyToken };
}

const AUTH = { authorization: "Bearer good" };

describe("auth guard", () => {
  it("401 without a bearer token and 401 on a bad one", async () => {
    const { app } = build();
    const none = await app.inject({ method: "POST", url: "/api/fairs/imports/link", payload: { url: "https://x" } });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: "missing_token" });
    const bad = await app.inject({
      method: "POST",
      url: "/api/fairs/imports/link",
      headers: { authorization: "Bearer nope" },
      payload: { url: "https://x" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: "invalid_token" });
  });
});

describe("POST /api/fairs/imports/link", () => {
  it("400 on an invalid body", async () => {
    const { app, svc } = build();
    const res = await app.inject({ method: "POST", url: "/api/fairs/imports/link", headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(svc.startFromLink).not.toHaveBeenCalled();
  });

  it("202 with the import; trims the url and fair name", async () => {
    const { app, svc } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/fairs/imports/link",
      headers: AUTH,
      payload: { url: "  https://hackrice.com ", fairName: "  HackRice   16 " },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ import: IMPORT });
    expect(svc.startFromLink).toHaveBeenCalledWith("https://hackrice.com", "HackRice 16");
  });

  it("passes a LinkFailure through with its status (the console disables the link field on it)", async () => {
    const body = { error: "link_failed", reason: "http_error", message: "The page answered HTTP 403 (it needs a login)" };
    const { app } = build({ startFromLink: vi.fn(async () => ({ ok: false, status: 422, body })) });
    const res = await app.inject({
      method: "POST",
      url: "/api/fairs/imports/link",
      headers: AUTH,
      payload: { url: "https://gated.test" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual(body);
  });
});

describe("POST /api/fairs/imports/image", () => {
  const boundary = "----wingmantest";
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  function multipart(fileBytes: Buffer, withName = true): Buffer {
    const parts: Buffer[] = [];
    if (withName) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fairName"\r\n\r\nHackRice 16\r\n`));
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="roster.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
    );
    parts.push(fileBytes, Buffer.from(`\r\n--${boundary}--\r\n`));
    return Buffer.concat(parts);
  }

  it("202: sniffs the media type from the bytes and reads the fairName field sent before the file", async () => {
    const { app, svc } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/fairs/imports/image",
      headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(png),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().import.source).toBe("image");
    const [image, fairName] = (svc.startFromImage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(image).toMatchObject({ mediaType: "image/png", filename: "roster.png" });
    expect((image as { buffer: Buffer }).buffer.equals(png)).toBe(true);
    expect(fairName).toBe("HackRice 16");
  });

  it("415 when the bytes are not an image", async () => {
    const { app, svc } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/fairs/imports/image",
      headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(Buffer.from("%PDF-1.4 not an image"), false),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: "image_failed" });
    expect(svc.startFromImage).not.toHaveBeenCalled();
  });
});

describe("reads + reload", () => {
  it("GET /api/fairs/imports and /:importId", async () => {
    const { app } = build();
    const list = await app.inject({ method: "GET", url: "/api/fairs/imports", headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ imports: [IMPORT] });
    const one = await app.inject({ method: "GET", url: "/api/fairs/imports/imp_1", headers: AUTH });
    expect(one.json()).toEqual({ import: IMPORT });
    const missing = await app.inject({ method: "GET", url: "/api/fairs/imports/imp_404", headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /api/fairs/companies and POST /api/fairs/reload", async () => {
    const { app, svc } = build();
    const companies = await app.inject({ method: "GET", url: "/api/fairs/companies", headers: AUTH });
    expect(companies.json()).toEqual({ companies: [] });
    const reload = await app.inject({ method: "POST", url: "/api/fairs/reload", headers: AUTH });
    expect(reload.json()).toEqual({ corpusSize: 42 });
    expect(svc.reload).toHaveBeenCalledTimes(1);
  });

  it("503 when the DB read behind /companies throws", async () => {
    const { app } = build({
      companiesOnFile: vi.fn(async () => {
        throw new Error("db gone");
      }),
    });
    const res = await app.inject({ method: "GET", url: "/api/fairs/companies", headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "db_unavailable" });
  });
});
