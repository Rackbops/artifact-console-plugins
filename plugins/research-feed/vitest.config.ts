import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    alias: {
      "@ac/host": fileURLToPath(new URL("./src/ac-host.stub.ts", import.meta.url)),
    },
  },
})
