import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import type { FeedItem, Store } from "./store.js"
import { openStore } from "./store.js"

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  // node:sqlite (WAL mode) keeps the db file open until Store#close() runs; an open handle makes
  // Windows' rmSync fail with EPERM even with force: true, so every store a test opened (via the
  // tracked openTrackedStore below) must close before its temp dir is removed. A test calling the
  // real openStore directly and closing it itself (e.g. the reopen test) is unaffected -- this only
  // closes stores THIS file opened and didn't already close.
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // already closed by the test itself
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "research-feed-store-"))
  dirs.push(dir)
  return join(dir, "sub", "research-feed.db")
}

/** openStore, tracked for an automatic close in afterEach -- use this in any test that doesn't
 *  already call store.close() itself. */
function openTrackedStore(path: string): Store {
  const store = openStore(path)
  stores.push(store)
  return store
}

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "g1",
    cursor: "100",
    kind: "video",
    title: "A video",
    url: "https://example.com/v1",
    verdict: "keep",
    signalScore: 0.9,
    summary: "summary",
    keyTakeaways: ["a", "b"],
    watchLive: false,
    watchLiveReason: null,
    gradedAt: "2026-09-24T00:00:00.000Z",
    corrections: [],
    ...overrides,
  }
}

test("openStore creates its parent directory", () => {
  const path = tempDbPath()
  const store = openStore(path)
  store.close()
})

test("a grading returned twice is stored once", () => {
  const store = openStore(tempDbPath())
  store.applyPage([item()], "101")
  store.applyPage([item()], "101")
  expect(store.count()).toBe(1)
  store.close()
})

test("a correction re-surfacing an old grading replaces its corrections", () => {
  const store = openStore(tempDbPath())
  store.applyPage([item({ corrections: [] })], "101")
  store.applyPage(
    [
      item({
        cursor: "150",
        corrections: [
          {
            correctedVerdict: "drop",
            correctedWatchLive: null,
            note: "actually skip this",
            transcriptMissedIt: null,
            createdAt: "2026-09-24T01:00:00.000Z",
          },
        ],
      }),
    ],
    "151",
  )
  expect(store.count()).toBe(1)
  const grading = store.byId("g1")
  expect(grading?.cursor).toBe("150")
  expect(grading?.corrections).toHaveLength(1)
  expect(grading?.corrections[0]?.correctedVerdict).toBe("drop")
  store.close()
})

test("a page that fails mid-transaction leaves the cursor unchanged", () => {
  const store = openStore(tempDbPath())
  store.applyPage([item()], "101")
  expect(store.cursor()).toBe("101")

  const badItem = { ...item({ id: "g2", cursor: "102" }), url: undefined } as unknown as FeedItem
  expect(() => store.applyPage([badItem], "103")).toThrow()
  expect(store.cursor()).toBe("101")
  expect(store.count()).toBe(1)
  store.close()
})

test("/verdicts (latestPerUrl) returns the latest grading per url", () => {
  const store = openTrackedStore(tempDbPath())
  store.applyPage(
    [
      item({
        id: "g1",
        url: "https://example.com/a",
        gradedAt: "2026-09-01T00:00:00.000Z",
        cursor: "1",
      }),
      item({
        id: "g2",
        url: "https://example.com/a",
        gradedAt: "2026-09-02T00:00:00.000Z",
        cursor: "2",
      }),
      item({
        id: "g3",
        url: "https://example.com/b",
        gradedAt: "2026-09-01T00:00:00.000Z",
        cursor: "3",
      }),
    ],
    "4",
  )
  const latest = store.latestPerUrl()
  expect(latest.map((g) => g.id).sort()).toEqual(["g2", "g3"])
})

test("latestPerUrl filters by verdict and watchLive", () => {
  const store = openTrackedStore(tempDbPath())
  store.applyPage(
    [
      item({ id: "g1", url: "https://example.com/a", verdict: "keep", watchLive: true }),
      item({ id: "g2", url: "https://example.com/b", verdict: "drop", watchLive: false }),
    ],
    "3",
  )
  expect(store.latestPerUrl({ verdict: "keep" }).map((g) => g.id)).toEqual(["g1"])
  expect(store.latestPerUrl({ watchLive: true }).map((g) => g.id)).toEqual(["g1"])
  expect(store.latestPerUrl({ verdict: "drop", watchLive: true }).map((g) => g.id)).toEqual([])
})

test("historyFor (via /verdicts/:id) includes every grading sharing its url, newest first", () => {
  const store = openTrackedStore(tempDbPath())
  store.applyPage(
    [
      item({
        id: "g1",
        url: "https://example.com/a",
        gradedAt: "2026-09-01T00:00:00.000Z",
        cursor: "1",
      }),
      item({
        id: "g2",
        url: "https://example.com/a",
        gradedAt: "2026-09-02T00:00:00.000Z",
        cursor: "2",
      }),
    ],
    "3",
  )
  const history = store.historyFor("https://example.com/a")
  expect(history.map((g) => g.id)).toEqual(["g2", "g1"])
})

test("byId for an unknown id returns undefined", () => {
  const store = openTrackedStore(tempDbPath())
  expect(store.byId("nope")).toBeUndefined()
})

test("the store survives reopen (the restart property at unit level)", () => {
  const path = tempDbPath()
  const first = openStore(path)
  first.applyPage([item()], "101")
  first.close()

  const second = openStore(path)
  expect(second.count()).toBe(1)
  expect(second.cursor()).toBe("101")
  expect(second.byId("g1")?.url).toBe("https://example.com/v1")
  second.close()
})

test("setPollState/pollState round-trips, and /healthz is 200 while the feed is unreachable", () => {
  const store = openStore(tempDbPath())
  store.setPollState({
    state: "unreachable",
    lastAttemptAt: "2026-09-24T02:00:00.000Z",
    lastSuccessAt: "2026-09-24T01:00:00.000Z",
    error: "connect ECONNREFUSED",
  })
  const state = store.pollState()
  expect(state?.state).toBe("unreachable")
  expect(state?.error).toBe("connect ECONNREFUSED")
  // The store itself never gates on poll state -- healthz's own 200-while-unreachable behavior is
  // asserted at the http.ts layer (http.test.ts); this just confirms the state that backs it.
  store.close()
})
