import type { CreatePlugin } from "@rackbops/ac-plugin-contract"

/**
 * `plugins/hello-remote` — the reference third-party plugin (#105): one route, one panel, one card.
 * It exists to prove the install path from a published index works end to end, so it does the least
 * possible: `GET /ping` answers a static greeting. `createPlugin(host)` is pure (no host I/O) — only
 * `activate()` registers the route, matching every in-process plugin's lifecycle.
 */
export const createPlugin: CreatePlugin = (host) => ({
  activate() {
    host.routes.register("GET", "/ping", async () =>
      Response.json({ ok: true, greeting: "hello from an installed plugin" }),
    )
  },
})
