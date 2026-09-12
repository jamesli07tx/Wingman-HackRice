// INTEGRATION: fixtures/generate.ts (cortex/fixtures — the no-hardware test rig, DESIGN_WINDOWS.md §1)
// IN:  nothing (run `pnpm -F @wingman/cortex fixtures`)
// OUT: cortex/fixtures/frame-NN-<class>.jpg — the canned frame walk
//      (nothing x3 -> banner x3 -> nothing x2 -> document x2), longest edge <= 768 px,
//      JPEG q~0.6, i.e. exactly the shape a real device sends per DESIGN.md §4.2.
// WIRE: MockDeviceAdapter reads this directory at start(); nothing else consumes it.
//
// These are deliberately synthetic (sharp -> SVG -> JPEG): the point is a deterministic,
// checked-in sequence that exercises SceneGate -> Identify -> Context -> Pitch -> Scan
// with zero hardware. Swap in real photos of a printed banner/pamphlet with the same
// filenames and every consumer keeps working.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { FRAME_MAX_EDGE_PX } from "@wingman/shared";

const OUT_DIR = fileURLToPath(new URL(".", import.meta.url));
const W = FRAME_MAX_EDGE_PX; // 768
const H = Math.round((W * 3) / 4); // 576 — 4:3, longest edge = 768

/** An empty corridor: floor band, far wall, a couple of doorways. Nothing to detect. */
function nothingScene(variant: number): string {
  const shift = variant * 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#c9cdd2"/>
  <rect x="0" y="${H * 0.62}" width="${W}" height="${H * 0.38}" fill="#8d9298"/>
  <rect x="${40 + shift}" y="${H * 0.18}" width="110" height="${H * 0.44}" fill="#b3b8be"/>
  <rect x="${430 - shift}" y="${H * 0.2}" width="130" height="${H * 0.42}" fill="#b3b8be"/>
  <rect x="${600 - shift}" y="${H * 0.3}" width="90" height="${H * 0.32}" fill="#aab0b6"/>
  <rect x="0" y="${H * 0.6}" width="${W}" height="6" fill="#7c8288"/>
  <text x="24" y="${H - 20}" font-family="sans-serif" font-size="18" fill="#6d7278">hallway ${variant + 1}</text>
</svg>`;
}

/** A booth banner filling the centre of view: big wordmark + a logo-ish block. */
function bannerScene(variant: number): string {
  const jitter = variant * 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#d7dade"/>
  <rect x="0" y="${H * 0.78}" width="${W}" height="${H * 0.22}" fill="#8d9298"/>
  <rect x="${60 + jitter}" y="${40 + jitter / 2}" width="${W - 120 - jitter * 2}" height="${H * 0.6}" rx="10" fill="#635bff"/>
  <rect x="${96 + jitter}" y="${76 + jitter / 2}" width="86" height="86" rx="16" fill="#ffffff"/>
  <rect x="${112 + jitter}" y="${96 + jitter / 2}" width="54" height="14" rx="7" fill="#635bff"/>
  <rect x="${112 + jitter}" y="${122 + jitter / 2}" width="54" height="14" rx="7" fill="#635bff"/>
  <text x="${W / 2}" y="${H * 0.42}" text-anchor="middle" font-family="sans-serif" font-size="104" font-weight="bold" fill="#ffffff">STRIPE</text>
  <text x="${W / 2}" y="${H * 0.55}" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#e4e2ff">Payments infrastructure</text>
  <text x="${W / 2}" y="${H * 0.9}" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#3c4148">Booth 14 — now hiring interns</text>
</svg>`;
}

/** A pamphlet held close to the camera: page fills the frame, readable lines. */
function documentScene(variant: number): string {
  const skew = variant * 6;
  const lines = [
    "STRIPE — University Recruiting 2027",
    "SWE Intern — apply by Oct 15",
    "New Grad Backend — apply by Nov 1",
    "Stack: Ruby, Go, TypeScript, ML infra",
    "stripe.com/jobs · university@stripe.com",
  ];
  const body = lines
    .map(
      (t, i) =>
        `<text x="72" y="${196 + i * 54}" font-family="sans-serif" font-size="${i === 0 ? 30 : 26}" font-weight="${i === 0 ? "bold" : "normal"}" fill="#1d2125">${t}</text>`,
    )
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#5f646a"/>
  <rect x="${36 + skew}" y="${18 + skew}" width="${W - 72 - skew * 2}" height="${H - 36 - skew * 2}" rx="6" fill="#fbfbf9"/>
  <rect x="72" y="${64 + skew}" width="240" height="46" rx="8" fill="#635bff"/>
  <text x="92" y="${96 + skew}" font-family="sans-serif" font-size="28" font-weight="bold" fill="#ffffff">STRIPE</text>
  ${body}
  <rect x="72" y="${H - 96}" width="${W - 216}" height="3" fill="#c9cdd2"/>
  <text x="72" y="${H - 62}" font-family="sans-serif" font-size="20" fill="#5f646a">Career Fair · HackRice 16</text>
</svg>`;
}

/** The frame walk of DESIGN_WINDOWS.md §1, in replay order. */
const WALK: { cls: "nothing" | "banner" | "document"; svg: string }[] = [
  { cls: "nothing", svg: nothingScene(0) },
  { cls: "nothing", svg: nothingScene(1) },
  { cls: "nothing", svg: nothingScene(2) },
  { cls: "banner", svg: bannerScene(0) },
  { cls: "banner", svg: bannerScene(1) },
  { cls: "banner", svg: bannerScene(2) },
  { cls: "nothing", svg: nothingScene(3) },
  { cls: "nothing", svg: nothingScene(4) },
  { cls: "document", svg: documentScene(0) },
  { cls: "document", svg: documentScene(1) },
];

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  for (let i = 0; i < WALK.length; i++) {
    const { cls, svg } = WALK[i]!;
    const name = `frame-${String(i).padStart(2, "0")}-${cls}.jpg`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 60 }).toBuffer();
    await writeFile(new URL(name, import.meta.url), jpeg);
    // eslint-disable-next-line no-console
    console.log(`${name}  ${(jpeg.byteLength / 1024).toFixed(1)} KB`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
