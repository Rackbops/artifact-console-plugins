import { defineConfig } from "vitest/config"

// The root `vitest run` (package.json's `test`, and the last step of `check`) covers only
// scripts/**/*.test.ts -- each plugin under plugins/* has its own vitest.config.ts and is run by
// `pnpm -r test` instead, so a plugin's tests are never run (or double-run) from here.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
  },
})
