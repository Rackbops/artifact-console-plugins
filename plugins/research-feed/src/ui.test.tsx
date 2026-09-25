// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const hostFetch = vi.fn()
const hostCached = vi.fn()
vi.mock("@ac/host", () => ({
  fetch: (...args: unknown[]) => hostFetch(...args),
  cached: (...args: unknown[]) => hostCached(...args),
}))

const { ResearchFeedPanel, ResearchFeedCard, shortTime } = await import("./ui.js")

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body }
}

function makeVerdict(id: string, verdict: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Link ${id}`,
    verdict,
    signalScore: 0.5,
    summary: null,
    watchLive: false,
    watchLiveReason: null,
    gradedAt: "2026-09-24T00:00:00.000Z",
    corrections: [],
    ...extra,
  }
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
      screen.getByText(
        "Research feed unavailable: the research-feed-store sidecar isn't reachable",
      ),
    ).toBeTruthy(),
  )
  expect(screen.getByText("connect ECONNREFUSED")).toBeTruthy()
  expect(screen.getByRole("alert").className).toContain("rb-alert--warning")
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
  if (!call) throw new Error("submit was never called")
  expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
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

test("each verdict badge is coloured by its verdict", async () => {
  hostFetch
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        verdicts: [
          makeVerdict("k", "keep"),
          makeVerdict("g", "grey_area"),
          makeVerdict("d", "drop"),
          makeVerdict("u", "mystery"),
        ],
      }),
    )
  const { container } = render(<ResearchFeedPanel />)
  await waitFor(() => expect(screen.getByText("Link k")).toBeTruthy())
  const badge = (verdict: string) => {
    const el = container.querySelector(`.ac-rf__row [data-verdict="${verdict}"]`)
    if (!el) throw new Error(`no badge for ${verdict}`)
    return el
  }
  expect(badge("keep").className).toContain("rb-badge--success")
  expect(badge("keep").textContent).toBe("Keep")
  expect(badge("grey_area").className).toContain("rb-badge--warning")
  expect(badge("grey_area").textContent).toBe("Grey area")
  expect(badge("drop").className).toContain("rb-badge--danger")
  expect(badge("drop").textContent).toBe("Drop")
  // An unknown verdict is the neutral badge carrying its raw value, never a guessed colour.
  expect(badge("mystery").className).toBe("rb-badge")
  expect(badge("mystery").textContent).toBe("mystery")
})

test("the active verdict filter is the pressed, primary button", async () => {
  hostFetch
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValue(jsonResponse({ ok: true, verdicts: [] }))
  render(<ResearchFeedPanel />)
  await waitFor(() => expect(screen.getByText("No verdicts yet.")).toBeTruthy())
  const all = screen.getByRole("button", { name: "All" })
  const drop = screen.getByRole("button", { name: "Drop" })
  expect(all.getAttribute("aria-pressed")).toBe("true")
  expect(all.className).toContain("rb-btn--primary")
  expect(drop.getAttribute("aria-pressed")).toBe("false")
  expect(drop.className).not.toContain("rb-btn--primary")

  fireEvent.click(drop)
  await waitFor(() => expect(drop.getAttribute("aria-pressed")).toBe("true"))
  expect(drop.className).toContain("rb-btn--primary")
  expect(all.className).not.toContain("rb-btn--primary")
})

test("a watch-live row shows its badge and reason", async () => {
  hostFetch
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        verdicts: [makeVerdict("w", "keep", { watchLive: true, watchLiveReason: "live demo" })],
      }),
    )
  render(<ResearchFeedPanel />)
  await waitFor(() => expect(screen.getByText("live demo")).toBeTruthy())
  expect(screen.getByText("watch live").className).toContain("rb-badge--info")
})

test("a failed submit shows the server's error as a danger alert", async () => {
  hostFetch
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, verdicts: [] }))
    .mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "not a url research-triage takes" }, false),
    )
  render(<ResearchFeedPanel />)
  await waitFor(() => expect(screen.getByText("No verdicts yet.")).toBeTruthy())
  fireEvent.change(screen.getByLabelText("Summarise this link"), {
    target: { value: "https://example.com/bad" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Submit" }))
  const alert = await screen.findByRole("alert")
  expect(alert.textContent).toBe("not a url research-triage takes")
  expect(alert.className).toContain("rb-alert--danger")
})

test("a successful submit's confirmation is a success alert", async () => {
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
  const alert = await screen.findByRole("alert")
  expect(alert.className).toContain("rb-alert--success")
})

test("the panel shows a loading note until the verdicts load", async () => {
  hostFetch.mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
  let resolveVerdicts: (v: unknown) => void = () => {}
  hostFetch.mockReturnValueOnce(
    new Promise((r) => {
      resolveVerdicts = r
    }),
  )
  render(<ResearchFeedPanel />)
  expect(screen.getByText("Loading…")).toBeTruthy()
  await waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(2))
  resolveVerdicts(jsonResponse({ ok: true, verdicts: [] }))
  await waitFor(() => expect(screen.getByText("No verdicts yet.")).toBeTruthy())
  expect(screen.queryByText("Loading…")).toBeNull()
})

test("the card colours each row's dot by verdict and links the title", async () => {
  hostCached
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        verdicts: [
          makeVerdict("k", "keep"),
          makeVerdict("g", "grey_area"),
          makeVerdict("d", "drop"),
        ],
      }),
    )
  render(<ResearchFeedCard />)
  await waitFor(() => expect(screen.getByText("Link k")).toBeTruthy())
  expect(screen.getByRole("img", { name: "Keep" }).className).toContain("ac-rf-card__dot--keep")
  expect(screen.getByRole("img", { name: "Grey area" }).className).toContain(
    "ac-rf-card__dot--grey_area",
  )
  expect(screen.getByRole("img", { name: "Drop" }).className).toContain("ac-rf-card__dot--drop")
  expect(screen.getByRole("link", { name: "Link k" }).getAttribute("href")).toBe(
    "https://example.com/k",
  )
})

test("shortTime trims an ISO timestamp to minutes and passes anything else through", () => {
  expect(shortTime("2026-09-24T01:02:03.000Z")).toBe("2026-09-24 01:02")
  expect(shortTime("yesterday")).toBe("yesterday")
})

test("the card shows the empty state when unavailable", async () => {
  hostCached.mockResolvedValueOnce(
    jsonResponse({ ok: false, available: false, reason: "connect ECONNREFUSED" }),
  )
  render(<ResearchFeedCard />)
  await waitFor(() =>
    expect(
      screen.getByText(
        "Research feed unavailable: the research-feed-store sidecar isn't reachable",
      ),
    ).toBeTruthy(),
  )
})

test("the card's unavailable message is a plain note, never a card inside the wrapper's card", async () => {
  hostCached.mockResolvedValueOnce(
    jsonResponse({ ok: false, available: false, reason: "connect ECONNREFUSED" }),
  )
  const { container } = render(<ResearchFeedCard />)
  const note = await screen.findByText(
    "Research feed unavailable: the research-feed-store sidecar isn't reachable",
  )
  expect(note.className).toBe("ac-rf-card__note")
  expect(container.querySelector(".rb-card")).toBeNull()
  expect(screen.queryByRole("heading")).toBeNull()
})

test("an empty feed is a level-2 heading under the panel's h1", async () => {
  hostFetch
    .mockResolvedValueOnce(jsonResponse({ ok: true, feed: { state: "ok" } }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, verdicts: [] }))
  render(<ResearchFeedPanel />)
  expect(await screen.findByRole("heading", { level: 2, name: "No verdicts yet." })).toBeTruthy()
})
