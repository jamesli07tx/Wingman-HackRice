// Link entry point: HTML -> text that keeps the names a sponsor wall hides in
// aria-label / alt / logo filenames, plus the failure classification the console
// relies on to disable the link field (design grill Q3/Q5).

import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  fetchPage,
  focusText,
  pageTitle,
  stripToText,
} from "../../src/fairs/fetchPage.js";
import type { FetchLike } from "../../src/fairs/fetchPage.js";

const SPONSOR_HTML = `<html><head><title>HackRice 16 &mdash; Sponsors</title><style>.x{color:red}</style></head><body>
<script>var sponsors = ["Should Not Leak"];</script>
<nav><a href="#sponsors">Sponsors</a></nav>
<section id="sponsors"><ul>
<li><a href="https://www.mathworks.com/" aria-label="MathWorks — visit website"><span class="sr-only">MathWorks</span></a></li>
<li><a href="https://lovable.dev/" aria-label="Lovable — visit website"><div class="logo"></div></a></li>
<li><img src="/img/sponsors/capital-one.svg" alt="Capital One logo"></li>
<li><img src="/img/sponsors/goldman_sachs.png"></li>
</ul></section>
<p>Rice &amp; friends &#169; 2026 &#x2014; see you</p>
</body></html>`;

const okFetch =
  (html: string): FetchLike =>
  async () => ({ ok: true, status: 200, text: async () => html, json: async () => ({}) });

describe("stripToText", () => {
  it("surfaces accessible names, alt text and logo filenames; drops scripts and styles", () => {
    const text = stripToText(SPONSOR_HTML);
    expect(text).toContain("MathWorks — visit website");
    expect(text).toContain("Lovable — visit website");
    expect(text).toContain("Capital One logo");
    expect(text).toContain("[logo: goldman sachs]");
    expect(text).not.toContain("Should Not Leak");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<");
    expect(text).toContain("Rice & friends © 2026 — see you");
  });

  it("keeps screen-reader-only text (it is ordinary text once tags go)", () => {
    expect(stripToText(`<a><span class="sr-only">Coveron</span></a>`)).toBe("Coveron");
  });
});

describe("pageTitle / decodeEntities", () => {
  it("reads and decodes the title", () => {
    expect(pageTitle(SPONSOR_HTML)).toBe("HackRice 16 — Sponsors");
    expect(pageTitle("<html><body>no title</body></html>")).toBeNull();
  });

  it("decodes named, decimal and hex entities and leaves unknown ones alone", () => {
    expect(decodeEntities("a &amp; b &#65; &#x42; &nbsp;c &bogus;")).toBe("a & b A B  c &bogus;");
  });
});

describe("focusText", () => {
  it("returns short text unchanged", () => {
    expect(focusText("short", 100)).toBe("short");
  });

  it("keeps windows around roster words on long pages instead of blindly truncating", () => {
    const filler = "lorem ipsum ".repeat(5000);
    const text = `${filler}SPONSORS: MathWorks, Lovable ${filler}`;
    const out = focusText(text, 4000);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain("SPONSORS: MathWorks, Lovable");
  });

  it("falls back to the head when no roster word appears", () => {
    const text = "x".repeat(10_000);
    expect(focusText(text, 500)).toHaveLength(500);
  });
});

describe("fetchPage — failure classification", () => {
  it("invalid_url for junk and non-http schemes", async () => {
    expect(await fetchPage("not a url", { fetchImpl: okFetch("") })).toMatchObject({
      ok: false,
      reason: "invalid_url",
    });
    expect(await fetchPage("ftp://x.test/list", { fetchImpl: okFetch("") })).toMatchObject({
      ok: false,
      reason: "invalid_url",
    });
  });

  it("http_error with a login hint on 401/403", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 403,
      text: async () => "",
      json: async () => ({}),
    });
    const r = await fetchPage("https://x.test/list", { fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: "http_error" });
    expect(r.ok ? "" : r.message).toContain("login");
  });

  it("fetch_failed when the transport throws", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ENOTFOUND");
    };
    const r = await fetchPage("https://nope.test", { fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: "fetch_failed" });
    expect(r.ok ? "" : r.message).toContain("ENOTFOUND");
  });

  it("timeout when the deadline aborts the request", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const r = await fetchPage("https://slow.test", { fetchImpl, timeoutMs: 10 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("empty_page when nothing readable survives stripping", async () => {
    const r = await fetchPage("https://x.test", {
      fetchImpl: okFetch("<html><body><script>app()</script></body></html>"),
    });
    expect(r).toMatchObject({ ok: false, reason: "empty_page" });
  });
});

describe("fetchPage — success", () => {
  it("returns text + title + normalised url, follows redirects, identifies itself", async () => {
    let seen: { url: string; init: Parameters<FetchLike>[1] } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => SPONSOR_HTML, json: async () => ({}) };
    };
    const r = await fetchPage("https://hackrice.com", { fetchImpl });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://hackrice.com/");
      expect(r.title).toBe("HackRice 16 — Sponsors");
      expect(r.text).toContain("MathWorks");
    }
    expect(seen!.init?.redirect).toBe("follow");
    expect(seen!.init?.headers?.["user-agent"]).toContain("Wingman");
  });
});
