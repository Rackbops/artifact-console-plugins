import type { HostApi } from "@rackbops/ac-plugin-contract"
import { expect, test } from "vitest"
import { createPlugin } from "./server.js"

type Registered = {
  method: string
  path: string
  handler: (r: Request) => Response | Promise<Response>
}

/** A minimal fake HostApi that records route registrations, the plugins/hello server.test.ts shape. */
function fakeHost() {
  const routes: Registered[] = []
  const host = {
    routes: {
      register: (method: string, path: string, handler: Registered["handler"]) =>
        routes.push({ method, path, handler }),
    },
  } as unknown as HostApi
  return { host, routes }
}

test("createPlugin is pure -- it does no host I/O in its body", () => {
  const throwingHost = new Proxy(
    {},
    {
      get() {
        throw new Error("createPlugin must not do I/O")
      },
    },
  ) as unknown as HostApi
  expect(() => createPlugin(throwingHost)).not.toThrow()
})

test("activate registers exactly GET /ping", () => {
  const { host, routes } = fakeHost()
  createPlugin(host).activate()
  expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /ping"])
})

test("GET /ping answers 200 with { ok: true, greeting }", async () => {
  const { host, routes } = fakeHost()
  createPlugin(host).activate()
  const res = await routes[0]?.handler(new Request("http://x/api/x/hello-remote/ping"))
  expect(res?.status).toBe(200)
  expect(await res?.json()).toEqual({
    ok: true,
    greeting: "hello from an installed plugin",
  })
})
