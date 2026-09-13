import path from "node:path";
import type { NextConfig } from "next";

// @wingman/shared ships raw TypeScript (package exports point at ./src/index.ts),
// so Next must transpile it. The extensionAlias entry lets the shared package's
// ESM-style ".js" specifiers (e.g. `import type { ArmedConfig } from "./protocol.js"`)
// resolve to the ".ts" sources under webpack.
const nextConfig: NextConfig = {
  transpilePackages: ["@wingman/shared"],
  // pnpm monorepo: trace from the repo root so the linked @wingman/shared sources
  // are bundled (and so Next stops guessing at an unrelated lockfile).
  outputFileTracingRoot: path.join(process.cwd(), ".."),
  typescript: {
    // Type errors are caught by `pnpm -F @wingman/console typecheck`, which also
    // covers files Next does not compile.
    ignoreBuildErrors: false,
  },
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
