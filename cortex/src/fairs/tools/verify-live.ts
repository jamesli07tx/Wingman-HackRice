// LIVE verification for the fair list import — talks to the real Supabase,
// Tavily and Anthropic using the root .env. Not a vitest file. Spends real
// money (cents of opus-5) and Tavily credits (1 per new company), so run it
// on purpose. From the repo root:
//
//   pnpm -C cortex exec tsx src/fairs/tools/verify-live.ts --extract-only --url https://hackrice.com
//   pnpm -C cortex exec tsx src/fairs/tools/verify-live.ts --import --url https://hackrice.com --fair "HackRice 16"
//   pnpm -C cortex exec tsx src/fairs/tools/verify-live.ts --roster-image roster.png
//   pnpm -C cortex exec tsx src/fairs/tools/verify-live.ts --extract-only --image roster.png
//   pnpm -C cortex exec tsx src/fairs/tools/verify-live.ts --identify MathWorks [--expect mathworks]
//
// --identify renders a synthetic booth banner for NAME (same recipe as
// cortex/fixtures/generate.ts), builds an IdentifyService from the CURRENT
// companies table and asserts the model answers with the expected corpusId —
// i.e. the "auto-identify" proof that an imported sponsor is now recognised.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { slugify } from "../../context/ContextService.js";
import { IdentifyService } from "../../identify/IdentifyService.js";
import { SwappableIdentifier } from "../SwappableIdentifier.js";
import { loadIdentifyCorpus } from "../corpus.js";
import { createFairImportService } from "../index.js";
import { extractWithOpus, sniffImageType } from "../extract.js";
import { fetchPage } from "../fetchPage.js";

dotenv.config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const HACKRICE_SPONSORS = [
  "Capital One",
  "Coveron",
  "ElevenLabs",
  "Goldman Sachs",
  "Incogni",
  "Jeni's Ice Creams",
  "Lilie",
  "Lovable",
  "MathWorks",
  "NordPass",
  "NordVPN",
  "Notability",
  "Persona",
  "Pure Buttons",
  "Rice Computer Science",
  "Rice Engineering Alumni",
  "Rice Ken Kennedy Institute",
  "Saily",
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`${name} is not set (root .env)`);
    process.exit(1);
  }
  return v;
}

function supabaseClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function bannerJpeg(name: string): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const W = 1024;
  const H = 768;
  const size = name.length > 14 ? 72 : 104;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#d7dade"/>
  <rect x="0" y="${H * 0.78}" width="${W}" height="${H * 0.22}" fill="#8d9298"/>
  <rect x="60" y="40" width="${W - 120}" height="${H * 0.6}" rx="10" fill="#0b5fa5"/>
  <text x="${W / 2}" y="${H * 0.42}" text-anchor="middle" font-family="sans-serif" font-size="${size}" font-weight="bold" fill="#ffffff">${escapeXml(name)}</text>
  <text x="${W / 2}" y="${H * 0.55}" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#dbe9ff">Now hiring interns</text>
  <text x="${W / 2}" y="${H * 0.9}" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#3c4148">Booth 7</text>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

async function rosterPng(names: string[], fairName: string): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const W = 900;
  const rowH = 46;
  const H = 140 + names.length * rowH;
  const rows = names
    .map(
      (n, i) =>
        `<text x="70" y="${130 + i * rowH}" font-family="sans-serif" font-size="28" fill="#1d2125">${escapeXml(n)}</text>` +
        `<text x="${W - 120}" y="${130 + i * rowH}" font-family="sans-serif" font-size="22" fill="#6d7278">Booth ${i + 1}</text>`,
    )
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#fbfbf9"/>
  <text x="70" y="70" font-family="sans-serif" font-size="36" font-weight="bold" fill="#1c2f52">${escapeXml(fairName)} — Sponsors &amp; Exhibitors</text>
  ${rows}
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function main(): Promise<void> {
  if (has("--roster-image")) {
    const out = arg("--roster-image")!;
    const names = arg("--names")?.split(",").map((s) => s.trim()).filter(Boolean) ?? HACKRICE_SPONSORS;
    await writeFile(out, await rosterPng(names, arg("--fair") ?? "HackRice 16"));
    console.log(`wrote ${out} (${names.length} names)`);
    return;
  }

  if (has("--extract-only")) {
    requireEnv("ANTHROPIC_API_KEY");
    const image = arg("--image");
    if (image) {
      const buffer = await readFile(image);
      const mediaType = sniffImageType(buffer);
      if (!mediaType) throw new Error("not a png/jpeg/webp/gif");
      const t0 = Date.now();
      const out = await extractWithOpus({ kind: "image", base64: buffer.toString("base64"), mediaType });
      report(out, Date.now() - t0);
      return;
    }
    const url = arg("--url") ?? "https://hackrice.com";
    const page = await fetchPage(url, { fetchImpl: fetch });
    if (!page.ok) throw new Error(`fetch failed: ${page.reason} — ${page.message}`);
    console.log(`fetched ${page.url} · title "${page.title}" · ${page.text.length} chars of text`);
    const t0 = Date.now();
    const out = await extractWithOpus({ kind: "text", text: page.text, sourceUrl: page.url, title: page.title });
    report(out, Date.now() - t0);
    return;
  }

  if (has("--import")) {
    requireEnv("ANTHROPIC_API_KEY");
    const supabase = supabaseClient();
    const url = arg("--url") ?? "https://hackrice.com";
    const boot = await loadIdentifyCorpus(supabase);
    const identifier = new SwappableIdentifier(new IdentifyService(boot));
    console.log(`identify list at start: ${boot.length} companies`);
    const service = createFairImportService({
      supabase,
      tavilyApiKey: process.env.TAVILY_API_KEY,
      logger: {
        info: (m, meta) => console.log(`[fairs] ${m}`, meta ?? ""),
        warn: (m, meta) => console.warn(`[fairs] WARN ${m}`, meta ?? ""),
      },
      reloadCorpus: async () => {
        const rows = await loadIdentifyCorpus(supabase);
        identifier.swap(new IdentifyService(rows));
        return rows.length;
      },
    });
    const t0 = Date.now();
    const start = await service.startFromLink(url, arg("--fair") ?? null);
    if (!start.ok) throw new Error(`start failed: ${JSON.stringify(start.body)}`);
    console.log(`import ${start.import.importId} "${start.import.fairName}" — ${start.import.total} companies (extraction ${Date.now() - t0} ms)`);
    const timer = setInterval(() => {
      const s = service.get(start.import.importId);
      if (s) console.log(`  … ${s.done}/${s.total}`);
    }, 5000);
    const done = await service.settled(start.import.importId);
    clearInterval(timer);
    if (!done) throw new Error("import vanished");
    console.log(`\nimport ${done.status} in ${Date.now() - t0} ms · reloaded=${done.reloaded} · identify list now ${done.corpusSize} companies (swap generation ${identifier.generation})`);
    for (const c of done.companies) console.log(`  ${pad(c.status, 9)} ${pad(c.companyId ?? "-", 28)} ${c.name}${c.note ? `  — ${c.note}` : ""}`);
    if (done.error) console.log(`  error: ${done.error}`);
    const failed = done.companies.filter((c) => c.status === "failed").length;
    if (failed > 0) process.exitCode = 1;
    return;
  }

  if (has("--identify")) {
    requireEnv("ANTHROPIC_API_KEY");
    const name = arg("--identify")!;
    const expected = arg("--expect") ?? slugify(name);
    const supabase = supabaseClient();
    const corpus = await loadIdentifyCorpus(supabase);
    const known = corpus.find((c) => c.companyId === expected);
    console.log(`identify list: ${corpus.length} companies · expected id "${expected}" is ${known ? "present" : "ABSENT"}`);
    const jpeg = await bannerJpeg(name);
    const out = arg("--save");
    if (out) await writeFile(out, jpeg);
    const t0 = Date.now();
    const result = await new IdentifyService(corpus).identify(jpeg);
    console.log(`identify -> ${JSON.stringify(result)} (${Date.now() - t0} ms)`);
    if (result.corpusId !== expected) {
      console.error(`FAIL: expected corpusId "${expected}"`);
      process.exitCode = 1;
    } else {
      console.log(`PASS: banner for "${name}" identified as ${expected} at confidence ${result.confidence}`);
    }
    return;
  }

  if (has("--purge-imported")) {
    // Deletes ONLY rows this feature created (source = fair-import) so an import
    // can be re-run from scratch, e.g. after a Tavily key change. Matched rows
    // (csv/enrich/seed sources) are never touched. Requires --yes.
    const supabase = supabaseClient();
    const { data, error } = await supabase
      .from("companies")
      .select("company_id,name")
      .eq("source", "fair-import");
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { company_id: string; name: string }[];
    console.log(`${rows.length} fair-import rows: ${rows.map((r) => r.company_id).join(", ") || "(none)"}`);
    if (!has("--yes")) {
      console.log("dry run — add --yes to delete them");
      return;
    }
    const del = await supabase.from("companies").delete().eq("source", "fair-import");
    if (del.error) throw new Error(del.error.message);
    console.log(`deleted ${rows.length} rows`);
    return;
  }

  if (has("--tavily-check")) {
    // Reports only the HTTP status: a dead or unrotated key shows up as 401/403
    // here AND as `search_down` on the live path. Never prints the key.
    const apiKey = process.env.TAVILY_API_KEY?.trim();
    if (!apiKey) {
      console.log("TAVILY_API_KEY: not set");
      return;
    }
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ api_key: apiKey, query: "MathWorks company overview", search_depth: "basic", max_results: 1 }),
    });
    const body = (await res.text()).slice(0, 160).replace(/\s+/g, " ");
    console.log(`Tavily HTTP ${res.status} ${res.ok ? "OK" : "FAILED"} · ${body}`);
    process.exitCode = res.ok ? 0 : 1;
    return;
  }

  console.log("usage: see the header of this file");
}

function report(out: { fairName: string | null; companies: { name: string; aliases: string[] }[] }, ms: number): void {
  console.log(`fairName: ${out.fairName ?? "(none)"} · ${out.companies.length} companies (${ms} ms)`);
  for (const c of out.companies) console.log(`  - ${c.name}${c.aliases.length ? `  [${c.aliases.join(", ")}]` : ""}`);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
