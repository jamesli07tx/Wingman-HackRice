// Provisions cortex on AWS: SSM secrets -> IAM role -> S3 code bundle ->
// EC2 (t3.micro, AL2023, systemd) -> CloudFront (trusted HTTPS + WebSockets).
// Run AFTER `aws configure`:   node scripts/aws/provision.mjs
// Secret values are read from the root .env and passed only as child-process
// arguments — they are never printed.
// Idempotent-ish: safe to re-run; existing resources are reused.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const REGION = process.env.AWS_REGION || "us-east-1";
const SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "TAVILY_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CLERK_SECRET_KEY",
];

function aws(args, { json = true, allowFail = [] } = {}) {
  try {
    const out = execFileSync("aws", [...args, "--region", REGION], { encoding: "utf8" });
    return json && out.trim() ? JSON.parse(out) : out;
  } catch (err) {
    const msg = String(err.stderr || err.message || "");
    if (allowFail.some((s) => msg.includes(s))) return null;
    // Never echo the failing argv (it may carry a secret) — name the operation only.
    throw new Error(`aws ${args[0]} ${args[1]} failed: ${msg.split("\n")[0]}`);
  }
}

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(REPO, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const hash = v.search(/\s#|^#/);
    if (hash >= 0) v = v.slice(0, hash).trim();
    v = v.replace(/^["']|["']$/g, "");
    if (v) env[m[1]] = v;
  }
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(label, fn, { tries = 60, gapMs = 10_000 }) {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (i % 6 === 0) console.log(`  waiting: ${label} (${i * gapMs / 1000}s)`);
    await sleep(gapMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// --- 0. identity + env -------------------------------------------------------
const ident = aws(["sts", "get-caller-identity"]);
const account = ident.Account;
console.log(`account ${account} · region ${REGION}`);
const env = loadEnv();
const missing = SECRET_KEYS.filter((k) => !env[k]);
if (missing.length) {
  console.error(`root .env is missing: ${missing.join(", ")}`);
  process.exit(1);
}

// --- 1. secrets -> SSM SecureStrings ----------------------------------------
for (const key of SECRET_KEYS) {
  aws(["ssm", "put-parameter", "--name", `/wingman/${key}`, "--type", "SecureString",
       "--value", env[key], "--overwrite"], { json: false });
}
console.log(`SSM: ${SECRET_KEYS.length} parameters under /wingman/ ✓`);

// --- 2. IAM role + instance profile -----------------------------------------
const ROLE = "wingman-ec2-role";
const trust = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
});
aws(["iam", "create-role", "--role-name", ROLE, "--assume-role-policy-document", trust],
  { allowFail: ["EntityAlreadyExists"] });
aws(["iam", "attach-role-policy", "--role-name", ROLE,
     "--policy-arn", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"], { json: false });
const inline = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters"],
      Resource: `arn:aws:ssm:${REGION}:${account}:parameter/wingman/*` },
    { Effect: "Allow", Action: "kms:Decrypt", Resource: "*",
      Condition: { StringEquals: { "kms:ViaService": `ssm.${REGION}.amazonaws.com` } } },
    { Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::wingman-deploy-${account}/*` },
  ],
});
aws(["iam", "put-role-policy", "--role-name", ROLE, "--policy-name", "wingman-inline",
     "--policy-document", inline], { json: false });
aws(["iam", "create-instance-profile", "--instance-profile-name", ROLE],
  { allowFail: ["EntityAlreadyExists"] });
aws(["iam", "add-role-to-instance-profile", "--instance-profile-name", ROLE, "--role-name", ROLE],
  { json: false, allowFail: ["LimitExceeded", "EntityAlreadyExists"] });
console.log("IAM: role + instance profile ✓ (waiting 15s for propagation)");
await sleep(15_000);

// --- 3. code bundle -> S3 ----------------------------------------------------
const BUCKET = `wingman-deploy-${account}`;
const createBucketArgs = ["s3api", "create-bucket", "--bucket", BUCKET];
if (REGION !== "us-east-1") {
  createBucketArgs.push("--create-bucket-configuration", `LocationConstraint=${REGION}`);
}
aws(createBucketArgs, { allowFail: ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"] });
const tmp = mkdtempSync(join(tmpdir(), "wingman-"));
const bundle = join(tmp, "wingman-bundle.tgz");
execFileSync("tar", ["-czf", bundle, "-C", REPO,
  "--exclude", "node_modules", "--exclude", ".env", "--exclude", "env.template",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "shared", "cortex"]);
aws(["s3", "cp", bundle, `s3://${BUCKET}/wingman-bundle.tgz`], { json: false });
const s3uri = `s3://${BUCKET}/wingman-bundle.tgz`;
console.log(`S3: bundle at ${s3uri} ✓`);

// --- 4. security group -------------------------------------------------------
const vpc = aws(["ec2", "describe-vpcs", "--filters", "Name=is-default,Values=true"]).Vpcs[0];
let sg = aws(["ec2", "describe-security-groups", "--filters",
  "Name=group-name,Values=wingman-cortex-sg", `Name=vpc-id,Values=${vpc.VpcId}`]).SecurityGroups[0];
if (!sg) {
  const created = aws(["ec2", "create-security-group", "--group-name", "wingman-cortex-sg",
    "--description", "wingman cortex origin", "--vpc-id", vpc.VpcId]);
  sg = { GroupId: created.GroupId };
}
aws(["ec2", "authorize-security-group-ingress", "--group-id", sg.GroupId,
  "--protocol", "tcp", "--port", "8080", "--cidr", "0.0.0.0/0"],
  { json: false, allowFail: ["InvalidPermission.Duplicate"] });
console.log(`SG: ${sg.GroupId} (8080 open; no SSH — use SSM Session Manager) ✓`);

// --- 5. EC2 instance ---------------------------------------------------------
let instance = aws(["ec2", "describe-instances", "--filters",
  "Name=tag:Name,Values=wingman-cortex", "Name=instance-state-name,Values=pending,running"])
  .Reservations?.[0]?.Instances?.[0];
if (instance) {
  console.log(`EC2: reusing ${instance.InstanceId}`);
} else {
  const ami = aws(["ssm", "get-parameter", "--name",
    "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"]).Parameter.Value;
  const userData = readFileSync(fileURLToPath(new URL("user-data.sh", import.meta.url)), "utf8")
    .replace(/\r\n/g, "\n") // Windows checkout CRLF would break bash on the instance
    .replaceAll("__S3_BUNDLE__", s3uri)
    .replaceAll("__REGION__", REGION);
  const udFile = join(tmp, "user-data.sh");
  writeFileSync(udFile, userData);
  instance = aws(["ec2", "run-instances", "--image-id", ami, "--instance-type", "t3.micro",
    "--security-group-ids", sg.GroupId, "--iam-instance-profile", `Name=${ROLE}`,
    "--user-data", `file://${udFile}`,
    "--tag-specifications", "ResourceType=instance,Tags=[{Key=Name,Value=wingman-cortex}]"]).Instances[0];
  console.log(`EC2: launched ${instance.InstanceId}`);
}
const dns = await poll("EC2 public DNS", async () => {
  const d = aws(["ec2", "describe-instances", "--instance-ids", instance.InstanceId])
    .Reservations[0].Instances[0].PublicDnsName;
  return d || null;
}, { tries: 30, gapMs: 5_000 });
console.log(`EC2: ${dns}`);

console.log("waiting for cortex on the origin (first boot installs Node + deps; ~3-6 min)…");
await poll("origin /healthz", async () => {
  const res = await fetch(`http://${dns}:8080/healthz`, { signal: AbortSignal.timeout(4000) });
  return res.ok ? true : null;
}, { tries: 60, gapMs: 10_000 });
console.log("origin healthz ✓");

// --- 6. CloudFront -----------------------------------------------------------
const existing = aws(["cloudfront", "list-distributions"]).DistributionList?.Items?.find(
  (d) => d.Comment === "wingman-cortex",
);
let dist = existing;
if (!dist) {
  const cfg = {
    CallerReference: `wingman-${Date.now()}`,
    Comment: "wingman-cortex",
    Enabled: true,
    Origins: { Quantity: 1, Items: [{
      Id: "cortex-ec2", DomainName: dns,
      CustomOriginConfig: {
        HTTPPort: 8080, HTTPSPort: 443, OriginProtocolPolicy: "http-only",
        OriginReadTimeout: 60, OriginKeepaliveTimeout: 60,
      },
    }] },
    DefaultCacheBehavior: {
      TargetOriginId: "cortex-ec2",
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: { Quantity: 7,
        Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
      Compress: false,
      // Managed policies: CachingDisabled + AllViewer (Authorization, ?token=, everything forwarded)
      CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      OriginRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3",
    },
  };
  const cfgFile = join(tmp, "cf.json");
  writeFileSync(cfgFile, JSON.stringify(cfg));
  dist = aws(["cloudfront", "create-distribution", "--distribution-config", `file://${cfgFile}`]).Distribution;
  console.log(`CloudFront: created ${dist.Id}`);
} else {
  console.log(`CloudFront: reusing ${dist.Id}`);
}
const domain = dist.DomainName;
console.log(`CloudFront: ${domain} — waiting for Deployed (~5-15 min)…`);
await poll("CloudFront deployed", async () => {
  const d = aws(["cloudfront", "get-distribution", "--id", dist.Id]).Distribution;
  return d.Status === "Deployed" ? true : null;
}, { tries: 90, gapMs: 15_000 });
await poll("public /healthz via CloudFront", async () => {
  const res = await fetch(`https://${domain}/healthz`, { signal: AbortSignal.timeout(6000) });
  return res.ok ? true : null;
}, { tries: 20, gapMs: 10_000 });

console.log("\n================= DONE =================");
console.log(`CORTEX URL:     https://${domain}`);
console.log(`CORTEX WS URL:  wss://${domain}`);
console.log("Next: node scripts/vercel-deploy.mjs https://" + domain);
console.log("Mac side Config.local.xcconfig gets the same two URLs.");
console.log("Redeploys: node scripts/aws/redeploy.mjs");
