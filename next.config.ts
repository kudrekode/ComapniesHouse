import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Avoid generating editor-agent instruction files whenever the demo starts.
  agentRules: false,
};

export default nextConfig;
