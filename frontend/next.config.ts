import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  // assetPrefix intentionally absent. The Electron renderer loads
  // this bundle over http://127.0.0.1:<port>/ (served by the Rust
  // daemon's axum + tower-http ServeDir), so the default absolute
  // `/_next/...` URLs resolve correctly across nested routes and
  // there's no CORS boundary between the renderer and the daemon's
  // /logs/stream WebSocket. The legacy `assetPrefix: "./"` worked
  // for the root index but broke sub-route asset resolution because
  // the relative prefix was anchored at the sub-route's own
  // directory under file://.
};

export default nextConfig;
