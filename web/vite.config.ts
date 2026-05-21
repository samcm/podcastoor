import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.PODCASTOOR_API ?? "http://localhost:3729";
const proxy = Object.fromEntries(
  ["/api", "/audio", "/assets", "/feeds", "/health", "/metrics"].map((route) => [route, { target: backend, changeOrigin: true }])
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  build: { outDir: "dist", emptyOutDir: true },
});
