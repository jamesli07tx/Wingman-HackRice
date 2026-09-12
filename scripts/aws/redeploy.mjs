// Ships the current working tree's cortex to the running EC2 instance:
// re-bundle -> S3 -> SSM RunCommand (unpack, reinstall, restart systemd unit).
// Usage: node scripts/aws/redeploy.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const REGION = process.env.AWS_REGION || "us-east-1";

function aws(args, { json = true } = {}) {
  const out = execFileSync("aws", [...args, "--region", REGION], { encoding: "utf8" });
  return json && out.trim() ? JSON.parse(out) : out;
}

const account = aws(["sts", "get-caller-identity"]).Account;
const BUCKET = `wingman-deploy-${account}`;
const instance = aws(["ec2", "describe-instances", "--filters",
  "Name=tag:Name,Values=wingman-cortex", "Name=instance-state-name,Values=running"])
  .Reservations?.[0]?.Instances?.[0];
if (!instance) {
  console.error("no running wingman-cortex instance — run provision.mjs first");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "wingman-"));
const bundle = join(tmp, "wingman-bundle.tgz");
execFileSync("tar", ["-czf", bundle, "-C", REPO,
  "--exclude", "node_modules", "--exclude", ".env", "--exclude", "env.template",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "shared", "cortex"]);
aws(["s3", "cp", bundle, `s3://${BUCKET}/wingman-bundle.tgz`], { json: false });
console.log("bundle uploaded");

const cmd = aws(["ssm", "send-command", "--instance-ids", instance.InstanceId,
  "--document-name", "AWS-RunShellScript", "--parameters", JSON.stringify({
    commands: [
      `aws s3 cp s3://${BUCKET}/wingman-bundle.tgz /tmp/wingman-bundle.tgz --region ${REGION}`,
      "tar -xzf /tmp/wingman-bundle.tgz -C /opt/wingman",
      'cd /opt/wingman && pnpm install --frozen-lockfile --filter "@wingman/cortex..."',
      "systemctl restart wingman-cortex",
      "sleep 3 && curl -sf http://localhost:8080/healthz",
    ],
  })]);
const cmdId = cmd.Command.CommandId;
console.log(`SSM command ${cmdId} sent — waiting…`);
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const inv = aws(["ssm", "get-command-invocation", "--command-id", cmdId,
    "--instance-id", instance.InstanceId]);
  if (["Success", "Failed", "Cancelled", "TimedOut"].includes(inv.Status)) {
    console.log(`status: ${inv.Status}`);
    console.log(inv.StandardOutputContent?.slice(-400) ?? "");
    if (inv.Status !== "Success") console.error(inv.StandardErrorContent?.slice(-800) ?? "");
    process.exit(inv.Status === "Success" ? 0 : 1);
  }
}
console.error("timed out waiting for SSM command");
process.exit(1);
