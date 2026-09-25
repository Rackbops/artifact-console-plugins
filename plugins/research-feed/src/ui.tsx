import { cached, fetch as hostFetch } from "@ac/host"
import { type FormEvent, useEffect, useState } from "react"

/**
 * `plugins/research-feed`'s frontend (#106, decision 10): imports only `react` and `@ac/host` (no
 * `@rackbops/ui-react`, to keep the external surface minimal). `ResearchFeedPanel` at `/research`
 * and `ResearchFeedCard` (sizes `["1x3"]`) both treat `available: false` from `GET .../status` as
 * the empty state -- nothing here can take the console down when the sidecar isn't reachable.
 */

interface Correction {
  correctedVerdict: string | null
  correctedWatchLive: boolean | null
  note: string | null
  transcriptMissedIt: boolean | null
  createdAt: string
}

interface Verdict {
  id: string
  url: string
  title: string | null
  verdict: "keep" | "grey_area" | "drop"
  signalScore: number | null
  summary: string | null
  watchLive: boolean
  watchLiveReason: string | null
  gradedAt: string
  corrections: Correction[]
}

interface StatusBody {
  ok: boolean
  feed?: { state: string }
  available?: boolean
  reason?: string
}

const VERDICT_LABELS: Record<string, string> = {
  keep: "Keep",
  grey_area: "Grey area",
  drop: "Drop",
}

const UNAVAILABLE_MESSAGE =
  "Research feed unavailable: the research-feed-store sidecar isn't reachable"

function isUnavailable(status: StatusBody | null): boolean {
  return status !== null && status.available === false
}

function useStatus(fetcher: typeof hostFetch) {
  const [status, setStatus] = useState<StatusBody | null>(null)
  useEffect(() => {
    let cancelled = false
    fetcher("/api/x/research-feed/status")
      .then((res) => res.json())
      .then((body: StatusBody) => {
        if (!cancelled) setStatus(body)
      })
      .catch(() => {
        if (!cancelled) setStatus({ ok: false, available: false, reason: "network error" })
      })
    return () => {
      cancelled = true
    }
  }, [fetcher])
  return status
}

export function ResearchFeedPanel() {
  const status = useStatus(hostFetch)
  const [verdictFilter, setVerdictFilter] = useState("")
  const [watchLiveOnly, setWatchLiveOnly] = useState(false)
  const [verdicts, setVerdicts] = useState<Verdict[]>([])
  const [loaded, setLoaded] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [history, setHistory] = useState<Verdict[]>([])
  const [submitUrl, setSubmitUrl] = useState("")
  const [submitResult, setSubmitResult] = useState<string | null>(null)

  useEffect(() => {
    // Wait until status has actually loaded (not just "not yet known to be unavailable") -- status
    // starts null, and isUnavailable(null) is false, so gating on that alone fires this effect a
    // second, premature time on mount before useStatus's own fetch has resolved.
    if (status === null || isUnavailable(status)) return
    const params = new URLSearchParams()
    if (verdictFilter) params.set("verdict", verdictFilter)
    if (watchLiveOnly) params.set("watchLive", "true")
    const qs = params.toString()
    let cancelled = false
    hostFetch(`/api/x/research-feed/verdicts${qs ? `?${qs}` : ""}`)
      .then((res) => res.json())
      .then((body: { ok: boolean; verdicts?: Verdict[] }) => {
        if (!cancelled) {
          setVerdicts(body.verdicts ?? [])
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [status, verdictFilter, watchLiveOnly])

  function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null)
      setHistory([])
      return
    }
    setExpandedId(id)
    hostFetch(`/api/x/research-feed/verdicts/${encodeURIComponent(id)}`)
      .then((res) => res.json())
      .then((body: { history?: Verdict[] }) => setHistory(body.history ?? []))
      .catch(() => setHistory([]))
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitResult(null)
    hostFetch("/api/x/research-feed/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: submitUrl }),
    })
      .then(async (res) => {
        if (res.ok) {
          setSubmitResult("Submitted -- it appears after the next poll")
          setSubmitUrl("")
        } else {
          const body = await res.json().catch(() => ({}) as { error?: string; reason?: string })
          setSubmitResult(body.error ?? body.reason ?? "Submit failed")
        }
      })
      .catch(() => setSubmitResult("Submit failed"))
  }

  if (isUnavailable(status)) {
    return (
      <div>
        <h1>Research</h1>
        <p>{UNAVAILABLE_MESSAGE}</p>
        {status?.reason ? <p>{status.reason}</p> : null}
      </div>
    )
  }

  return (
    <div>
      <h1>Research</h1>
      <fieldset aria-label="verdict filter">
        {["", "keep", "grey_area", "drop"].map((v) => (
          <button
            key={v || "all"}
            type="button"
            aria-pressed={verdictFilter === v}
            onClick={() => setVerdictFilter(v)}
          >
            {v === "" ? "All" : (VERDICT_LABELS[v] ?? v)}
          </button>
        ))}
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={watchLiveOnly}
          onChange={(e) => setWatchLiveOnly(e.target.checked)}
        />
        Watch live only
      </label>

      {loaded && verdicts.length === 0 ? <p>No verdicts yet.</p> : null}

      <ul>
        {verdicts.map((v) => (
          <li key={v.id}>
            <a href={v.url} target="_blank" rel="noreferrer">
              {v.title ?? v.url}
            </a>{" "}
            <span>{VERDICT_LABELS[v.verdict] ?? v.verdict}</span>{" "}
            {v.signalScore !== null ? <span>{v.signalScore}</span> : null}{" "}
            {v.watchLive ? (
              <span>watch live{v.watchLiveReason ? `: ${v.watchLiveReason}` : ""}</span>
            ) : null}
            {v.summary ? <p>{v.summary}</p> : null}
            <button type="button" onClick={() => toggleExpand(v.id)}>
              {expandedId === v.id ? "Hide history" : "Show history"}
            </button>
            {expandedId === v.id ? (
              <ul aria-label={`history for ${v.id}`}>
                {history.map((h) => (
                  <li key={h.id}>
                    <span>{h.gradedAt}</span> <span>{VERDICT_LABELS[h.verdict] ?? h.verdict}</span>
                    {h.corrections.map((c) => (
                      <div key={c.createdAt}>
                        {c.correctedVerdict ? <span>corrected to {c.correctedVerdict}</span> : null}
                        {c.note ? <span>{c.note}</span> : null}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      <form onSubmit={handleSubmit}>
        <label htmlFor="research-feed-submit-url">Summarise this link</label>
        <input
          id="research-feed-submit-url"
          type="url"
          value={submitUrl}
          onChange={(e) => setSubmitUrl(e.target.value)}
          required
        />
        <button type="submit">Submit</button>
        {submitResult ? <p>{submitResult}</p> : null}
      </form>
    </div>
  )
}

export function ResearchFeedCard() {
  const [status, setStatus] = useState<StatusBody | null>(null)
  const [verdicts, setVerdicts] = useState<Verdict[]>([])

  useEffect(() => {
    let cancelled = false
    cached("/api/x/research-feed/status")
      .then((res) => res.json())
      .then((body: StatusBody) => {
        if (!cancelled) setStatus(body)
      })
      .catch(() => {
        if (!cancelled) setStatus({ ok: false, available: false, reason: "network error" })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Same "wait for status to actually load" rule as the panel's own effect -- see its comment.
    if (status === null || isUnavailable(status)) return
    let cancelled = false
    cached("/api/x/research-feed/verdicts?limit=5")
      .then((res) => res.json())
      .then((body: { verdicts?: Verdict[] }) => {
        if (!cancelled) setVerdicts(body.verdicts ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [status])

  if (isUnavailable(status)) {
    return <div>{UNAVAILABLE_MESSAGE}</div>
  }

  const watchLiveCount = verdicts.filter((v) => v.watchLive).length

  return (
    <div>
      <p>{watchLiveCount} watch live</p>
      <ul>
        {verdicts.slice(0, 5).map((v) => (
          <li key={v.id}>{v.title ?? v.url}</li>
        ))}
      </ul>
    </div>
  )
}
