import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/dashboard.ts"],
      thresholds: { lines: 80, functions: 70, statements: 80, branches: 70 }
    }
  }
});
