import type { Config } from "./config.js"
import { feedHeaders } from "./config.js"
import type { FeedItem, Store } from "./store.js"

/**
 * The poll loop (#453 decision 6): pages `GET /api/feed/gradings?since=&limit=500` until an empty
 * page, committing each page's upserts + advanced cursor in one transaction (`Store.applyPage`). A
 * failed poll records `unreachable` and keeps the old cursor -- the next tick retries from where it
 * left off. Each HTTP request has its own 30s timeout.
 */

export type FetchFn = typeof fetch

const REQUEST_TIMEOUT_MS = 30_000
const PAGE_LIMIT = 500

export interface PollResult {
  ok: boolean
  pages: number
  error?: string
}

interface FeedPage {
  items: FeedItem[]
  nextCursor: string
}

function isFeedPage(body: unknown): body is FeedPage {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { items?: unknown }).items) &&
    typeof (body as { nextCursor?: unknown }).nextCursor === "string"
  )
}

async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function pollOnce(
  config: Config,
  store: Store,
  fetchFn: FetchFn = fetch,
): Promise<PollResult> {
  const attemptAt = new Date().toISOString()

  if (!config.configured || !config.feedUrl) {
    const previous = store.pollState()
    store.setPollState({
      state: "unconfigured",
      lastAttemptAt: attemptAt,
      lastSuccessAt: previous?.lastSuccessAt,
      error: undefined,
    })
    return { ok: false, pages: 0 }
  }

  const headers = feedHeaders(config)
  let since = store.cursor()
  let pages = 0

  try {
    // Page until a page is empty (the feed's own "nextCursor equals since when a page is empty"
    // rule is what terminates the loop -- items.length === 0, not nextCursor === since, since a
    // page could in principle report an unchanged cursor with items still on it).
    for (;;) {
      const url = new URL("/api/feed/gradings", config.feedUrl)
      url.searchParams.set("since", since)
      url.searchParams.set("limit", String(PAGE_LIMIT))

      const res = await fetchWithTimeout(fetchFn, url.toString(), { headers }, REQUEST_TIMEOUT_MS)
      if (!res.ok) {
        throw new Error(`feed responded ${res.status} for GET /api/feed/gradings`)
      }
      const body: unknown = await res.json()
      if (!isFeedPage(body)) {
        throw new Error("feed returned a malformed page (missing items[] or nextCursor)")
      }
      store.applyPage(body.items, body.nextCursor)
      pages++
      if (body.items.length === 0) break
      since = body.nextCursor
    }

    store.setPollState({
      state: "ok",
      lastAttemptAt: attemptAt,
      lastSuccessAt: attemptAt,
      error: undefined,
    })
    return { ok: true, pages }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const previous = store.pollState()
    store.setPollState({
      state: "unreachable",
      lastAttemptAt: attemptAt,
      lastSuccessAt: previous?.lastSuccessAt,
      error: message,
    })
    return { ok: false, pages, error: message }
  }
}

export interface Poller {
  /** Trigger a poll immediately, awaiting its result -- used by the CI smoke's POST /__poll hook
   *  (30s is the real minimum interval). A no-op re-entrant guard: a tick already in flight is
   *  awaited rather than started twice. */
  tick(): Promise<PollResult>
  stop(): void
}

export function startPoller(config: Config, store: Store, fetchFn: FetchFn = fetch): Poller {
  let inFlight: Promise<PollResult> | undefined

  const tick = (): Promise<PollResult> => {
    if (inFlight) return inFlight
    inFlight = pollOnce(config, store, fetchFn).finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const interval = setInterval(() => {
    void tick()
  }, config.pollSeconds * 1000)
  interval.unref()

  // Poll once immediately at start-up rather than waiting a full interval, so /healthz reflects a
  // real feed.state shortly after boot.
  void tick()

  return {
    tick,
    stop: () => clearInterval(interval),
  }
}
