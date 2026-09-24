import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // vitest 4 started discovering the compiled *.test.js copies tsc emits into dist/ (rootDir:
    // src -> outDir: dist has no test-file filter), running each test twice.
    exclude: ["**/node_modules/**", "**/dist/**"],
    // "@ac/host" only resolves for real via a running host's import map -- there is no such module
    // outside one, so it's aliased to a local, test-only stub (never shipped in dist/) that
    // ui.test.tsx then replaces per test with vi.mock.
    alias: {
      "@ac/host": fileURLToPath(new URL("./src/ac-host.stub.ts", import.meta.url)),
    },
  },
})
