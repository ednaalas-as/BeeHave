import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// Opt-in LAN testing (`npm run lan`): extra hostnames Vite should answer to,
// e.g. BEEHAVE_WEB_ALLOWED_HOSTS=my-mac.local. Unset keeps Vite's defaults.
const allowedHosts = (process.env.BEEHAVE_WEB_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    ...(allowedHosts.length ? { allowedHosts } : {}),
    proxy: { "/api": process.env.BEEHAVE_API_PROXY ?? "http://127.0.0.1:3001" },
  },
});
