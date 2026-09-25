import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // vitest 4 started discovering the compiled *.test.js copies tsc emits into app/ (rootDir: src
    // -> outDir: app has no test-file filter), running each test twice -- the hello-remote
    // vitest.config.ts precedent (there it's dist/, here it's app/).
    exclude: ["**/node_modules/**", "**/app/**"],
  },
})
