import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { readFileSync } from "fs";

const tauriConf = JSON.parse(
  readFileSync("./src-tauri/tauri.conf.json", "utf-8")
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(tauriConf.version),
  },
});
