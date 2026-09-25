import type { HostApi } from "@rackbops/ac-plugin-contract"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPlugin } from "./server.js"

type Registered = {
  method: string
  path: string
  handler: (r: Request) => Response | Promise<Response>
}

function fakeHost(baseUrl = "http://research-feed-store:8000") {
  const routes: Registered[] = []
  const host = {
    routes: {
      register: (method: string, path: string, handler: Registered["handler"]) =>
        routes.push({ method, path, handler }),
    },
    sidecar: {
      baseUrl: (id: string) => {
        expect(id).toBe("research-feed-store")
        return baseUrl
      },
    },
  } as unknown as HostApi
  return { host, routes }
}

function findRoute(routes: Registered[], method: string, path: string): Registered {
  const route = routes.find((r) => r.method === method && r.path === path)
  if (!route) throw new Error(`no route registered for ${method} ${path}`)
  return route
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

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

test("activate registers exactly the five declared routes", () => {
  const { host, routes } = fakeHost()
  createPlugin(host).activate()
  expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
    "GET /status",
    "GET /verdicts",
    "GET /verdicts/:id",
    "GET /history",
    "POST /submit",
  ])
})

test("GET /status calls the sidecar base url and proxies /healthz", async () => {
  fetchMock.mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({ ok: true, feed: { state: "ok" }, mirrored: 3 }),
  })
  const { host, routes } = fakeHost("http://research-feed-store:8000")
  createPlugin(host).activate()
  const res = await findRoute(routes, "GET", "/status").handler(
    new Request("http://x/api/x/research-feed/status"),
  )
  expect(fetchMock).toHaveBeenCalledWith(
    "http://research-feed-store:8000/healthz",
    expect.objectContaining({ method: "GET" }),
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, feed: { state: "ok" }, mirrored: 3 })
})

test("a sidecar timeout or connection error answers 503 with available false", async () => {
  fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"))
  const { host, routes } = fakeHost()
  createPlugin(host).activate()
  const res = await findRoute(routes, "GET", "/status").handler(
    new Request("http://x/api/x/research-feed/status"),
  )
  expect(res.status).toBe(503)
  const body = await res.json()
  expect(body).toEqual({ ok: false, available: false, reason: "connect ECONNREFUSED" })
})

test("/verdicts passes verdict, watchLive and limit through and nothing else", async () => {
  fetchMock.mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({ ok: true, verdicts: [] }),
  })
  const { host, routes } = fakeHost("http://research-feed-store:8000")
  createPlugin(host).activate()
  await findRoute(routes, "GET", "/verdicts").handler(
    new Request(
      "http://x/api/x/research-feed/verdicts?verdict=keep&watchLive=true&limit=5&junk=ignored",
    ),
  )
  const [calledUrl] = fetchMock.mock.calls[0] as [string]
  const forwarded = new URL(calledUrl)
  expect(forwarded.pathname).toBe("/verdicts")
  expect([...forwarded.searchParams.keys()].sort()).toEqual(["limit", "verdict", "watchLive"])
  expect(forwarded.searchParams.get("verdict")).toBe("keep")
  expect(forwarded.searchParams.get("watchLive")).toBe("true")
  expect(forwarded.searchParams.get("limit")).toBe("5")
})

test("GET /verdicts/:id proxies to the sidecar's /verdicts/<id>", async () => {
  fetchMock.mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({ ok: true, verdict: { id: "g1" }, history: [] }),
  })
  const { host, routes } = fakeHost("http://research-feed-store:8000")
  createPlugin(host).activate()
  const res = await findRoute(routes, "GET", "/verdicts/:id").handler(
    new Request("http://x/api/x/research-feed/verdicts/g1"),
  )
  expect(fetchMock).toHaveBeenCalledWith(
    "http://research-feed-store:8000/verdicts/g1",
    expect.objectContaining({ method: "GET" }),
  )
  expect(res.status).toBe(200)
})

test("GET /history forwards only limit", async () => {
  fetchMock.mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify({ ok: true, history: [] }),
  })
  const { host, routes } = fakeHost("http://research-feed-store:8000")
  createPlugin(host).activate()
  await findRoute(routes, "GET", "/history").handler(
    new Request("http://x/api/x/research-feed/history?limit=10&verdict=keep"),
  )
  const [calledUrl] = fetchMock.mock.calls[0] as [string]
  const forwarded = new URL(calledUrl)
  expect([...forwarded.searchParams.keys()]).toEqual(["limit"])
})

test("/submit forwards the url and relays the sidecar's status", async () => {
  fetchMock.mockResolvedValue({ status: 202, text: async () => JSON.stringify({ ok: true }) })
  const { host, routes } = fakeHost("http://research-feed-store:8000")
  createPlugin(host).activate()
  const res = await findRoute(routes, "POST", "/submit").handler(
    new Request("http://x/api/x/research-feed/submit", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/new" }),
    }),
  )
  expect(res.status).toBe(202)
  const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  expect(calledUrl).toBe("http://research-feed-store:8000/submit")
  expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com/new" })
})

test("POST /submit with no url is a 400 and never calls the sidecar", async () => {
  const { host, routes } = fakeHost()
  createPlugin(host).activate()
  const res = await findRoute(routes, "POST", "/submit").handler(
    new Request("http://x/api/x/research-feed/submit", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  )
  expect(res.status).toBe(400)
  expect(fetchMock).not.toHaveBeenCalled()
})
