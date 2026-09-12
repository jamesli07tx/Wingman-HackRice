// Launches the console dev server with env injected from the ROOT .env
// (Next.js only reads console/.env*, and the shared keys live at the repo
// root). Run from anywhere: node scripts/dev-console.mjs
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
process.env.PORT = "3000"; // never inherit cortex's 8080
console.log(
  `console starting on :3000 — cortex at ${process.env.NEXT_PUBLIC_CORTEX_URL}, clerk pk ${process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? "SET" : "MISSING"}`,
);

const isWin = process.platform === "win32";
const child = isWin
  ? spawn("cmd", ["/c", "pnpm", "-F", "@wingman/console", "dev"], { cwd: REPO, stdio: "inherit" })
  : spawn("pnpm", ["-F", "@wingman/console", "dev"], { cwd: REPO, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
