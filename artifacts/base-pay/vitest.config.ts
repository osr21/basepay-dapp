import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.integration.test.tsx", "test/stockflow-trade-contract.test.ts", "test/stockflow-network-fees.test.ts"],
  },
});