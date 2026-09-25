import type { CreatePlugin, HostApi } from "@rackbops/ac-plugin-contract"

/**
 * `plugins/research-feed` (#106) -- the in-process half of the research-feed sidecar (#453). Every
 * route is a thin proxy to `host.sidecar.baseUrl("research-feed-store")` (decision 9), 5s timeout;
 * any sidecar failure answers `503 { ok: false, available: false, reason }` so nothing this plugin
 * does can take the console down. The UI treats `available: false` as the empty state.
 */

const SIDECAR_ID = "research-feed-store"
const SIDECAR_TIMEOUT_MS = 5_000
const VERDICTS_QUERY_PARAMS = ["verdict", "watchLive", "limit"]

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function unavailable(reason: string): Response {
  return Response.json({ ok: false, available: false, reason }, { status: 503 })
}

/** Only the named query params are forwarded to the sidecar -- nothing else the caller sent. */
function forwardedQuery(requestUrl: string, names: string[]): string {
  const search = new URL(requestUrl).searchParams
  const out = new URLSearchParams()
  for (const name of names) {
    const value = search.get(name)
    if (value !== null) out.set(name, value)
  }
  const qs = out.toString()
  return qs.length > 0 ? `?${qs}` : ""
}

async function proxy(
  host: HostApi,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  const base = host.sidecar.baseUrl(SIDECAR_ID)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    })
    const text = await res.text()
    let json: unknown = {}
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        return unavailable("sidecar returned a non-JSON response")
      }
    }
    return Response.json(json, { status: res.status })
  } catch (err) {
    return unavailable(errMessage(err))
  } finally {
    clearTimeout(timer)
  }
}

function parseVerdictId(requestUrl: string): string | undefined {
  const match = /\/verdicts\/([^/]+)\/?$/.exec(new URL(requestUrl).pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

export const createPlugin: CreatePlugin = (host) => ({
  activate() {
    host.routes.register("GET", "/status", () => proxy(host, "GET", "/healthz"))

    host.routes.register("GET", "/verdicts", (request) =>
      proxy(host, "GET", `/verdicts${forwardedQuery(request.url, VERDICTS_QUERY_PARAMS)}`),
    )

    // Registered after the literal /verdicts above and before /history -- a route table matches on
    // segment shape, not registration order, but this mirrors the manifest's own declared order
    // (plugins/scans's own convention comment).
    host.routes.register("GET", "/verdicts/:id", (request) => {
      const id = parseVerdictId(request.url)
      if (!id)
        return Promise.resolve(Response.json({ ok: false, error: "missing id" }, { status: 404 }))
      return proxy(host, "GET", `/verdicts/${encodeURIComponent(id)}`)
    })

    host.routes.register("GET", "/history", (request) =>
      proxy(host, "GET", `/history${forwardedQuery(request.url, ["limit"])}`),
    )

    host.routes.register("POST", "/submit", async (request) => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 })
      }
      const url = (body as { url?: unknown } | null)?.url
      if (typeof url !== "string" || url.length === 0) {
        return Response.json({ ok: false, error: "url is required" }, { status: 400 })
      }
      return proxy(host, "POST", "/submit", { url })
    })
  },
})
