// Deploys the console to Vercel production using the prebuilt monorepo flow.
// Usage: node scripts/vercel-deploy.mjs https://<cortex-domain>
// Requires: `vercel login` done; project wingman-console exists (it does).
// NEXT_PUBLIC_* values bake in at LOCAL build time; CLERK_SECRET_KEY comes
// from the Vercel project env (already set) for the server runtime.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CONSOLE = join(REPO, "console");
const cortexUrl = (process.argv[2] || "").replace(/\/$/, "");
if (!/^https:\/\//.test(cortexUrl)) {
  console.error("usage: node scripts/vercel-deploy.mjs https://<cortex-domain>");
  process.exit(1);
}
const wsUrl = cortexUrl.replace(/^https:/, "wss:");

// Load root .env for the Clerk publishable key at build time
for (const line of readFileSync(join(REPO, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  const hash = v.search(/\s#|^#/);
  if (hash >= 0) v = v.slice(0, hash).trim();
  v = v.replace(/^["']|["']$/g, "");
  if (v && !process.env[m[1]]) process.env[m[1]] = v;
}
process.env.NEXT_PUBLIC_CORTEX_URL = cortexUrl;
process.env.NEXT_PUBLIC_CORTEX_WS_URL = wsUrl;

const isWin = process.platform === "win32";
function run(args, label) {
  console.log(`\n== ${label}`);
  const r = isWin
    ? spawnSync("cmd", ["/c", "vercel", ...args], { cwd: CONSOLE, stdio: "inherit", env: process.env })
    : spawnSync("vercel", args, { cwd: CONSOLE, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`${label} failed`);
    process.exit(r.status ?? 1);
  }
}

run(["link", "--yes", "--project", "wingman-console"], "link");
run(["pull", "--yes", "--environment=production"], "pull settings");
run(["build", "--prod"], "local build (URLs bake in here)");
run(["deploy", "--prebuilt", "--prod"], "deploy prebuilt");
console.log(`\nDone. Console points at ${cortexUrl} / ${wsUrl}`);
console.log("Test on a PHONE: sign in -> /capture -> camera prompt should appear (HTTPS).");
