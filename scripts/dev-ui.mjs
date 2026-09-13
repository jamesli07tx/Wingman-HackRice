// Launches the redesigned console (ui/, package @wingman/ui) on :3001 with env
// injected from the ROOT .env, so it can run beside the current console on :3000
// (node scripts/dev-console.mjs). Cortex defaults to the local :8080; set
// NEXT_PUBLIC_CORTEX_URL / NEXT_PUBLIC_CORTEX_WS_URL in .env to point it at the
// deployed CloudFront cortex instead.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
for (const line of readFileSync(`${REPO}/.env`, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  const hash = v.search(/\s#|^#/);
  if (hash >= 0) v = v.slice(0, hash).trim();
  v = v.replace(/^["']|["']$/g, "");
  if (v && !process.env[m[1]]) process.env[m[1]] = v;
}
process.env.NEXT_PUBLIC_CORTEX_URL = process.env.NEXT_PUBLIC_CORTEX_URL || "http://localhost:8080";
process.env.NEXT_PUBLIC_CORTEX_WS_URL = process.env.NEXT_PUBLIC_CORTEX_WS_URL || "ws://localhost:8080";
process.env.PORT = "3001";
console.log(
  `ui (redesign) starting on :3001 — cortex at ${process.env.NEXT_PUBLIC_CORTEX_URL}, clerk pk ${process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? "SET" : "MISSING"}`,
);

const isWin = process.platform === "win32";
const child = isWin
  ? spawn("cmd", ["/c", "pnpm", "-F", "@wingman/ui", "dev"], { cwd: REPO, stdio: "inherit" })
  : spawn("pnpm", ["-F", "@wingman/ui", "dev"], { cwd: REPO, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
