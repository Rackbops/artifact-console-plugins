import type { IncomingMessage, ServerResponse } from "node:http"
import type { Config } from "./config.js"
import { feedHeaders } from "./config.js"
import type { Store } from "./store.js"

/**
 * The sidecar's own HTTP surface (#453 decision 7/8): GET /healthz, GET /verdicts[,/:id], GET
 * /history, POST /submit -- plain node:http (no runtime dependencies, decision 1). Request bodies
 * are capped at 16 KiB; everything else 404s as JSON.
 */

const MAX_BODY_BYTES = 16 * 1024
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export type FetchFn = typeof fetch

export interface HandlerDeps {
  store: Store
  config: Config
  fetchFn: FetchFn
  /** Only wired when config.testHooks is true (POST /__poll). */
  triggerPoll?: () => Promise<unknown>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(text)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request body too large"), { statusCode: 413 })
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { statusCode: 400 })
  }
}

function parseLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get("limit")
  if (raw === null) return DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

function healthBody(store: Store) {
  const pollState = store.pollState()
  return {
    ok: true,
    feed: {
      state: pollState?.state ?? "unconfigured",
      lastAttemptAt: pollState?.lastAttemptAt,
      lastSuccessAt: pollState?.lastSuccessAt,
      ...(pollState?.error !== undefined ? { error: pollState.error } : {}),
    },
    mirrored: store.count(),
  }
}

async function submitToFeed(
  config: Config,
  fetchFn: FetchFn,
  url: string,
): Promise<{ status: number; body: unknown } | { unavailable: true; error: string }> {
  if (!config.configured || !config.feedUrl) {
    return { unavailable: true, error: "the research feed is not configured" }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetchFn(new URL("/api/feed/submit", config.feedUrl).toString(), {
      method: "POST",
      headers: { ...feedHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    })
    const text = await res.text()
    let body: unknown = {}
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = { raw: text }
      }
    }
    return { status: res.status, body }
  } catch (err) {
    return { unavailable: true, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

export function createHandler(deps: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(req, res, deps).catch((err) => {
      const status = (err as { statusCode?: number }).statusCode ?? 500
      sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
    })
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
  const { store, config, fetchFn, triggerPoll } = deps
  const method = req.method ?? "GET"
  const url = new URL(req.url ?? "/", "http://internal")
  const { pathname, searchParams } = url

  if (method === "GET" && pathname === "/healthz") {
    return sendJson(res, 200, healthBody(store))
  }

  if (method === "GET" && pathname === "/verdicts") {
    const verdict = searchParams.get("verdict") ?? undefined
    const watchLiveRaw = searchParams.get("watchLive")
    const watchLive = watchLiveRaw === null ? undefined : watchLiveRaw === "true"
    const limit = parseLimit(searchParams)
    return sendJson(res, 200, { ok: true, verdicts: store.latestPerUrl({ verdict, watchLive, limit }) })
  }

  const verdictIdMatch = /^\/verdicts\/([^/]+)$/.exec(pathname)
  if (method === "GET" && verdictIdMatch?.[1]) {
    const id = decodeURIComponent(verdictIdMatch[1])
    const grading = store.byId(id)
    if (!grading) return sendJson(res, 404, { ok: false, error: "unknown verdict id" })
    return sendJson(res, 200, {
      ok: true,
      verdict: grading,
      history: store.historyFor(grading.url),
    })
  }

  if (method === "GET" && pathname === "/history") {
    const limit = parseLimit(searchParams)
    return sendJson(res, 200, { ok: true, history: store.history(limit) })
  }

  if (method === "POST" && pathname === "/submit") {
    const body = await readJsonBody(req)
    const submitUrl = (body as { url?: unknown } | null)?.url
    if (typeof submitUrl !== "string" || submitUrl.length === 0) {
      return sendJson(res, 400, { ok: false, error: "url is required" })
    }
    const result = await submitToFeed(config, fetchFn, submitUrl)
    if ("unavailable" in result) {
      // Never 502/504 (decision 8) -- behind Cloudflare an origin's own 502/504 is replaced, so the
      // sidecar always answers its own 503 instead, regardless of what actually failed.
      return sendJson(res, 503, { ok: false, error: result.error })
    }
    return sendJson(res, result.status, result.body)
  }

  if (config.testHooks && method === "POST" && pathname === "/__poll") {
    await triggerPoll?.()
    return sendJson(res, 200, { ok: true })
  }

  return sendJson(res, 404, { ok: false, error: "not found" })
}
