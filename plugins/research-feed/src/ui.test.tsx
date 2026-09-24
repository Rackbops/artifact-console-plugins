// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const hostFetch = vi.fn()
const hostCached = vi.fn()
vi.mock("@ac/host", () => ({
  fetch: (...args: unknown[]) => hostFetch(...args),
  cached: (...args: unknown[]) => hostCached(...args),
}))

const { ResearchFeedPanel, ResearchFeedCard } = await import("./ui.js")

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body }
}

afterEach(() => {
  cleanup()
  hostFetch.mockReset()
  hostCached.mockReset()
})

test("the panel shows the empty state when status is unavailable", async () => {
  hostFetch.mockResolvedValueOnce(
    jsonResponse({ ok: false, available: false, reason: "connect ECONNREFUSED" }),
  )
  render(<ResearchFeedPanel />)
  await waitFor(() =>
    expect(
      screen.getByText("Research feed unavailable: the research-feed-store sidecar isn't reachable"),
    ).toBeTruthy(),
  )
  expect(screen.getByText("connect ECONNREFUSED")).toBeTruthy()
})

test("the panel filters by verdict and watch-live", async () => {
  hostFetch
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValue(jsonResponse({ ok: true, verdicts: [] }))
  render(<ResearchFeedPanel />)
  await waitFor(() => expect(hostFetch).toHaveBeenCalledWith("/api/x/research-feed/verdicts"))

  fireEvent.click(screen.getByRole("button", { name: "Keep" }))
  await waitFor(() =>
    expect(hostFetch).toHaveBeenCalledWith("/api/x/research-feed/verdicts?verdict=keep"),
  )

  fireEvent.click(screen.getByLabelText("Watch live only"))
  await waitFor(() =>
    expect(hostFetch).toHaveBeenCalledWith(
      "/api/x/research-feed/verdicts?verdict=keep&watchLive=true",
    ),
  )
})

test("expanding a row shows its history and corrections", async () => {
  const verdict = {
    id: "g1",
    url: "https://example.com/a",
    title: "A link",
    verdict: "keep",
    signalScore: 0.8,
    summary: "summary",
    watchLive: false,
    watchLiveReason: null,
    gradedAt: "2026-09-24T00:00:00.000Z",
    corrections: [],
  }
  hostFetch
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, verdicts: [verdict] }))
    .mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        verdict,
        history: [
          {
            ...verdict,
            verdict: "drop",
            corrections: [
              {
                correctedVerdict: "drop",
                correctedWatchLive: null,
                note: "actually skip",
                transcriptMissedIt: null,
                createdAt: "2026-09-24T01:00:00.000Z",
              },
            ],
          },
        ],
      }),
    )
  render(<ResearchFeedPanel />)
  await waitFor(() => expect(screen.getByText("A link")).toBeTruthy())

  fireEvent.click(screen.getByRole("button", { name: "Show history" }))
  await waitFor(() => expect(screen.getByText("actually skip")).toBeTruthy())
  expect(hostFetch).toHaveBeenCalledWith("/api/x/research-feed/verdicts/g1")
})

test("submitting a url posts it and shows the confirmation", async () => {
  hostFetch
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, verdicts: [] }))
    .mockResolvedValueOnce(jsonResponse({ ok: true }))
  render(<ResearchFeedPanel />)
  await waitFor(() => expect(screen.getByText("No verdicts yet.")).toBeTruthy())

  fireEvent.change(screen.getByLabelText("Summarise this link"), {
    target: { value: "https://example.com/new" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Submit" }))

  await waitFor(() =>
    expect(screen.getByText("Submitted -- it appears after the next poll")).toBeTruthy(),
  )
  const call = hostFetch.mock.calls.find(([path]) => path === "/api/x/research-feed/submit")
  expect(call).toBeDefined()
  expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
    url: "https://example.com/new",
  })
})

test("the card shows the watch-live count and five latest verdicts", async () => {
  const verdicts = Array.from({ length: 6 }, (_, i) => ({
    id: `g${i}`,
    url: `https://example.com/${i}`,
    title: `Link ${i}`,
    verdict: "keep",
    signalScore: 0.5,
    summary: null,
    watchLive: i < 2,
    watchLiveReason: null,
    gradedAt: "2026-09-24T00:00:00.000Z",
    corrections: [],
  }))
  hostCached
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, verdicts }))
  render(<ResearchFeedCard />)
  await waitFor(() => expect(screen.getByText("2 watch live")).toBeTruthy())
  expect(screen.getAllByRole("listitem")).toHaveLength(5)
})

test("the card shows the empty state when unavailable", async () => {
  hostCached.mockResolvedValueOnce(
    jsonResponse({ ok: false, available: false, reason: "connect ECONNREFUSED" }),
  )
  render(<ResearchFeedCard />)
  await waitFor(() =>
    expect(
      screen.getByText("Research feed unavailable: the research-feed-store sidecar isn't reachable"),
    ).toBeTruthy(),
  )
})
