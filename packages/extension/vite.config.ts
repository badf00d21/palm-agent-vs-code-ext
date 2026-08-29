import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/webview",
  base: "./",
  resolve: {
    alias: {
      "@palm-agent/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  build: {
    outDir: "../../dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
