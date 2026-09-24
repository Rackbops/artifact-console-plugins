import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { readConfig } from "./config.js"
import { pollOnce } from "./poller.js"
import { openStore } from "./store.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "research-feed-poller-"))
  dirs.push(dir)
  return join(dir, "research-feed.db")
}

function configuredEnv(extra: Record<string, string> = {}) {
  return readConfig({
    RESEARCH_FEED_URL: "https://rt.example",
    RESEARCH_FEED_TOKEN: "rtf_x",
    ...extra,
  })
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

test("pollOnce sends the bearer and both CF-Access headers when set", async () => {
  const config = configuredEnv({
    RESEARCH_FEED_ACCESS_CLIENT_ID: "cid",
    RESEARCH_FEED_ACCESS_CLIENT_SECRET: "csecret",
  })
  const store = openStore(tempDbPath())
  const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: "0" }))
  await pollOnce(config, store, fetchFn)
  const call = fetchFn.mock.calls[0]
  if (!call) throw new Error("fetchFn was never called")
  const headers = (call[1] as RequestInit).headers as Record<string, string>
  expect(headers.Authorization).toBe("Bearer rtf_x")
  expect(headers["CF-Access-Client-Id"]).toBe("cid")
  expect(headers["CF-Access-Client-Secret"]).toBe("csecret")
  store.close()
})

test("pollOnce sends only the bearer when CF-Access credentials are unset", async () => {
  const config = configuredEnv()
  const store = openStore(tempDbPath())
  const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: "0" }))
  await pollOnce(config, store, fetchFn)
  const call = fetchFn.mock.calls[0]
  if (!call) throw new Error("fetchFn was never called")
  const headers = (call[1] as RequestInit).headers as Record<string, string>
  expect(headers.Authorization).toBe("Bearer rtf_x")
  expect(headers["CF-Access-Client-Id"]).toBeUndefined()
  store.close()
})

test("pollOnce pages until empty and stores the final cursor", async () => {
  const config = configuredEnv()
  const store = openStore(tempDbPath())
  const page1Item = {
    id: "g1",
    cursor: "10",
    kind: "video",
    title: null,
    url: "https://example.com/1",
    verdict: "keep",
    signalScore: null,
    summary: null,
    keyTakeaways: [],
    watchLive: false,
    watchLiveReason: null,
    gradedAt: "2026-09-24T00:00:00.000Z",
    corrections: [],
  }
  const page2Item = { ...page1Item, id: "g2", cursor: "20", url: "https://example.com/2" }
  const fetchFn = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ items: [page1Item], nextCursor: "10" }))
    .mockResolvedValueOnce(jsonResponse({ items: [page2Item], nextCursor: "20" }))
    .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: "20" }))

  const result = await pollOnce(config, store, fetchFn)
  expect(result.ok).toBe(true)
  expect(fetchFn).toHaveBeenCalledTimes(3)
  expect(store.count()).toBe(2)
  expect(store.cursor()).toBe("20")
  store.close()
})

test("a failed poll records unreachable and keeps the old cursor", async () => {
  const config = configuredEnv()
  const store = openStore(tempDbPath())
  const okItem = {
    id: "g1",
    cursor: "10",
    kind: "video",
    title: null,
    url: "https://example.com/1",
    verdict: "keep",
    signalScore: null,
    summary: null,
    keyTakeaways: [],
    watchLive: false,
    watchLiveReason: null,
    gradedAt: "2026-09-24T00:00:00.000Z",
    corrections: [],
  }
  const firstFetch = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ items: [okItem], nextCursor: "10" }))
    .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: "10" }))
  await pollOnce(config, store, firstFetch)
  expect(store.cursor()).toBe("10")

  const failingFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"))
  const result = await pollOnce(config, store, failingFetch)
  expect(result.ok).toBe(false)
  expect(store.cursor()).toBe("10")
  expect(store.pollState()?.state).toBe("unreachable")
  expect(store.pollState()?.error).toMatch(/ECONNREFUSED/)
  expect(store.pollState()?.lastSuccessAt).toBeDefined()
  store.close()
})

test("pollOnce reports unconfigured when RESEARCH_FEED_URL/TOKEN are unset, without fetching", async () => {
  const config = readConfig({})
  const store = openStore(tempDbPath())
  const fetchFn = vi.fn()
  const result = await pollOnce(config, store, fetchFn)
  expect(result.ok).toBe(false)
  expect(fetchFn).not.toHaveBeenCalled()
  expect(store.pollState()?.state).toBe("unconfigured")
  store.close()
})

test("a non-ok feed response is treated as a failed poll", async () => {
  const config = configuredEnv()
  const store = openStore(tempDbPath())
  const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }))
  const result = await pollOnce(config, store, fetchFn)
  expect(result.ok).toBe(false)
  expect(store.pollState()?.state).toBe("unreachable")
  store.close()
})
