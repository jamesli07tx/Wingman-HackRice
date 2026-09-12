// Prints selected KEY=VALUE lines from the repo-root .env to STDOUT for piping
// into `vercel env add`, `aws ssm put-parameter`, etc. — so secret values never
// appear in an agent transcript or terminal scrollback.
// Usage:  node scripts/pipe-env.mjs KEY1 KEY2 ...     (KEY=VALUE lines)
//         node scripts/pipe-env.mjs --value KEY       (bare value, no newline)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  const hash = v.search(/\s#|^#/);
  if (hash >= 0) v = v.slice(0, hash).trim();
  v = v.replace(/^["']|["']$/g, "");
  if (v) env[m[1]] = v;
}

const args = process.argv.slice(2);
if (args[0] === "--value") {
  const v = env[args[1]];
  if (!v) { console.error(`MISSING ${args[1]}`); process.exit(1); }
  process.stdout.write(v);
} else {
  const missing = args.filter((k) => !env[k]);
  if (missing.length) { console.error(`MISSING ${missing.join(",")}`); process.exit(1); }
  process.stdout.write(args.map((k) => `${k}=${env[k]}`).join("\n") + "\n");
}
