import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pinned to this directory. Next otherwise walks upward looking for a lockfile to infer the workspace root,
  // and any unrelated lockfile in a parent folder changes which files it traces — so the build output would
  // depend on what happens to sit outside the repository.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
