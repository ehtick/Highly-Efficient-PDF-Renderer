import { defineConfig } from "vite";

export default defineConfig({
  base: "/hepr-smoke/",
  optimizeDeps: { exclude: ["@soadzoor/hepr/bundler"] },
  worker: { format: "es" },
  build: { target: "es2022" }
});
