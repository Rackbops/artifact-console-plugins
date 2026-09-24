import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { readConfig } from "./config.js"
import { createHandler } from "./http.js"
import type { Store } from "./store.js"
import { openStore } from "./store.js"

const dirs: string[] = []
const servers: Server[] = []
const stores: Store[] = []
afterEach(() => {
  // Order matters on Windows: node:sqlite (WAL mode) keeps the db file open until Store#close()
  // runs, and an open handle makes the directory's rmSync fail with EPERM even with force: true --
  // so every store this test opened must close before its temp dir is removed.
  for (const server of servers.splice(0)) server.close()
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "research-feed-http-"))
  dirs.push(dir)
  return join(dir, "research-feed.db")
}

async function startServer(opts: {
  store?: Store
  config?: ReturnType<typeof readConfig>
  fetchFn?: typeof fetch
  triggerPoll?: () => Promise<unknown>
}): Promise<{ url: string; store: Store }> {
  const store = opts.store ?? openStore(tempDbPath())
  stores.push(store)
  const config = opts.config ?? readConfig({})
  const handler = createHandler({
    store,
    config,
    fetchFn: opts.fetchFn ?? fetch,
    triggerPoll: opts.triggerPoll,
  })
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("no server address")
  return { url: `http://127.0.0.1:${address.port}`, store }
}

test("/healthz is 200 while the feed is unreachable", async () => {
  const { url, store } = await startServer({})
  store.setPollState({
    state: "unreachable",
    lastAttemptAt: "2026-09-24T00:00:00.000Z",
    lastSuccessAt: undefined,
    error: "connect ECONNREFUSED",
  })
  const res = await fetch(`${url}/healthz`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; feed: { state: string }; mirrored: number }
  expect(body.ok).toBe(true)
  expect(body.feed.state).toBe("unreachable")
  expect(body.mirrored).toBe(0)
})

test("/verdicts/:id for an unknown id is 404", async () => {
  const { url } = await startServer({})
  const res = await fetch(`${url}/verdicts/nope`)
  expect(res.status).toBe(404)
})

test("/verdicts/:id includes every grading sharing its url, newest first", async () => {
  const { url, store } = await startServer({})
  const base = {
    kind: "video" as const,
    title: null,
    verdict: "keep" as const,
    signalScore: null,
    summary: null,
    keyTakeaways: [],
    watchLive: false,
    watchLiveReason: null,
    corrections: [],
  }
  store.applyPage(
    [
      {
        ...base,
        id: "g1",
        url: "https://example.com/a",
        cursor: "1",
        gradedAt: "2026-09-01T00:00:00.000Z",
      },
      {
        ...base,
        id: "g2",
        url: "https://example.com/a",
        cursor: "2",
        gradedAt: "2026-09-02T00:00:00.000Z",
      },
    ],
    "3",
  )
  const res = await fetch(`${url}/verdicts/g2`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    verdict: { id: string }
    history: { id: string }[]
  }
  expect(body.verdict.id).toBe("g2")
  expect(body.history.map((g) => g.id)).toEqual(["g2", "g1"])
})

test("/submit relays the upstream status and body", async () => {
  const config = readConfig({
    RESEARCH_FEED_URL: "https://rt.example",
    RESEARCH_FEED_TOKEN: "rtf_x",
  })
  const fetchFn = vi.fn().mockResolvedValue({
    status: 202,
    text: async () => JSON.stringify({ accepted: true }),
  } as Response)
  const { url } = await startServer({ config, fetchFn })
  const res = await fetch(`${url}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/new" }),
  })
  expect(res.status).toBe(202)
  expect(await res.json()).toEqual({ accepted: true })
  const [calledUrl, init] = fetchFn.mock.calls[0] as [string, RequestInit]
  expect(calledUrl).toBe("https://rt.example/api/feed/submit")
  expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com/new" })
})

test("/submit is 503 when unconfigured, never 502 or 504", async () => {
  const { url } = await startServer({})
  const res = await fetch(`${url}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/new" }),
  })
  expect(res.status).toBe(503)
  expect(await res.json()).toMatchObject({ ok: false })
})

test("/submit is 503 when the feed is unreachable, never 502 or 504", async () => {
  const config = readConfig({
    RESEARCH_FEED_URL: "https://rt.example",
    RESEARCH_FEED_TOKEN: "rtf_x",
  })
  const fetchFn = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"))
  const { url } = await startServer({ config, fetchFn })
  const res = await fetch(`${url}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/new" }),
  })
  expect(res.status).toBe(503)
  const body = (await res.json()) as { ok: boolean; error: string }
  expect(body.ok).toBe(false)
  expect(body.error).toMatch(/ECONNREFUSED/)
})

test("/__poll is 404 without RESEARCH_FEED_TEST_HOOKS", async () => {
  const config = readConfig({})
  const { url } = await startServer({ config, triggerPoll: async () => {} })
  const res = await fetch(`${url}/__poll`, { method: "POST" })
  expect(res.status).toBe(404)
})

test("/__poll triggers a poll when RESEARCH_FEED_TEST_HOOKS=1", async () => {
  const config = readConfig({ RESEARCH_FEED_TEST_HOOKS: "1" })
  const triggerPoll = vi.fn().mockResolvedValue(undefined)
  const { url } = await startServer({ config, triggerPoll })
  const res = await fetch(`${url}/__poll`, { method: "POST" })
  expect(res.status).toBe(200)
  expect(triggerPoll).toHaveBeenCalledTimes(1)
})

test("an unknown route is 404 JSON", async () => {
  const { url } = await startServer({})
  const res = await fetch(`${url}/nonexistent`)
  expect(res.status).toBe(404)
  const body = (await res.json()) as { ok: boolean }
  expect(body.ok).toBe(false)
})
