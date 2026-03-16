import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        panel: resolve(__dirname, "panel.html"),
        subtitle: resolve(__dirname, "subtitle.html"),
        setup: resolve(__dirname, "setup.html"),
      },
    },
  },
});
