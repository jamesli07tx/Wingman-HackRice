#!/bin/bash
# EC2 boot script for wingman-cortex (Amazon Linux 2023).
# Placeholders __S3_BUNDLE__ and __REGION__ are substituted by provision.mjs.
# Secrets NEVER appear here — they are read from SSM Parameter Store at boot
# using the instance role.
set -euxo pipefail

# 1G swap — t3.micro has 1GB RAM and pnpm install wants headroom
dd if=/dev/zero of=/swapfile bs=1M count=1024 && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

dnf install -y git tar xz

# Node 24 from nodejs.org (deterministic; distro packages lag)
curl -fsSL https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.xz -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
npm install -g pnpm@12.4.1

mkdir -p /opt/wingman
aws s3 cp "__S3_BUNDLE__" /tmp/wingman-bundle.tgz --region "__REGION__"
tar -xzf /tmp/wingman-bundle.tgz -C /opt/wingman

# Build /opt/wingman/.env from SSM SecureStrings (instance role grants read on /wingman/*)
: > /opt/wingman/.env
chmod 600 /opt/wingman/.env
for KEY in ANTHROPIC_API_KEY TAVILY_API_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY CLERK_SECRET_KEY; do
  VAL=$(aws ssm get-parameter --name "/wingman/$KEY" --with-decryption --query Parameter.Value --output text --region "__REGION__")
  echo "$KEY=$VAL" >> /opt/wingman/.env
done
echo "PORT=8080" >> /opt/wingman/.env

cd /opt/wingman
pnpm install --frozen-lockfile --filter "@wingman/cortex..."

cat > /etc/systemd/system/wingman-cortex.service <<'UNIT'
[Unit]
Description=Wingman cortex backend
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/wingman
EnvironmentFile=/opt/wingman/.env
ExecStart=/usr/local/bin/pnpm -F @wingman/cortex start
Restart=always
RestartSec=3
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now wingman-cortex
