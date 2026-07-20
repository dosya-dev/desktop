import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["chokidar", "graceful-fs", "electron-updater"] })],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    root: resolve(__dirname, "src/renderer"),
    // Pin the dev port so the renderer's dev origin is stable and matches the
    // API's CORS allowlist (http://localhost:5174) now that webSecurity is on.
    server: { port: 5174, strictPort: true },
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
        output: {
          // Split heavy vendors into their own long-cached chunks so a page
          // change doesn't re-download React/Query/icons, and the initial
          // parse cost is spread across smaller files.
          manualChunks(id: string) {
            if (!id.includes("node_modules")) return;
            if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler")) return "vendor-react";
            if (id.includes("react-router") || id.includes("@remix-run")) return "vendor-router";
            if (id.includes("@tanstack")) return "vendor-query";
            if (id.includes("lucide-react")) return "vendor-icons";
            return "vendor";
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer"),
      },
    },
  },
});
