import { cached, fetch as hostFetch } from "@ac/host"
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Label,
  type SemanticVariant,
} from "@rackbops/ui-react"
import { type FormEvent, useEffect, useState } from "react"

/**
 * `plugins/research-feed`'s frontend (#106, decision 10): imports only `react` (plus the compiler's
 * `react/jsx-runtime`), `@ac/host` and `@rackbops/ui-react` -- all import-map externals, so the
 * built `dist/ui.js` stays
 * self-contained (`check-bundles`). Controls and surfaces come from `@rackbops/ui-react`
 * (`Card`/`Button`/`Badge`/`Checkbox`/`Field`/`Alert`/`EmptyState`), themed by the console's
 * `--rb-*` tokens; the scoped `RESEARCH_FEED_CSS` below covers only what those don't (the row
 * lists, the history timeline), the same "inject one <style> tag" pattern the console's own core
 * plugins use. `ResearchFeedPanel` at `/research` and `ResearchFeedCard` (sizes `["1x3"]`) both
 * treat `available: false` from `GET .../status` as the empty state -- nothing here can take the
 * console down when the sidecar isn't reachable.
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

/** keep -> success, grey_area -> warning, drop -> danger; an unknown verdict gets no variant (the
 *  neutral badge), never a guessed colour. */
const VERDICT_VARIANTS: Record<string, SemanticVariant> = {
  keep: "success",
  grey_area: "warning",
  drop: "danger",
}

const UNAVAILABLE_MESSAGE =
  "Research feed unavailable: the research-feed-store sidecar isn't reachable"

function isUnavailable(status: StatusBody | null): boolean {
  return status !== null && status.available === false
}

function VerdictBadge({ verdict }: { verdict: string }) {
  return (
    <Badge variant={VERDICT_VARIANTS[verdict]} data-verdict={verdict}>
      {VERDICT_LABELS[verdict] ?? verdict}
    </Badge>
  )
}

/** "2026-09-24T01:02:03.000Z" -> "2026-09-24 01:02" (UTC, as stored) -- deterministic, no locale;
 *  anything not ISO-shaped is shown as-is. The full value stays on the element's `title`. */
export function shortTime(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(0, 16).replace("T", " ") : iso
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
  const [submitResult, setSubmitResult] = useState<{ ok: boolean; text: string } | null>(null)

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
          setSubmitResult({ ok: true, text: "Submitted -- it appears after the next poll" })
          setSubmitUrl("")
        } else {
          const body = await res.json().catch(() => ({}) as { error?: string; reason?: string })
          setSubmitResult({ ok: false, text: body.error ?? body.reason ?? "Submit failed" })
        }
      })
      .catch(() => setSubmitResult({ ok: false, text: "Submit failed" }))
  }

  if (isUnavailable(status)) {
    return (
      <div className="ac-rf">
        <style>{RESEARCH_FEED_CSS}</style>
        <h1 className="ac-rf__title">Research</h1>
        <Alert variant="warning" title={UNAVAILABLE_MESSAGE}>
          {status?.reason ? <p className="ac-rf__note">{status.reason}</p> : null}
        </Alert>
      </div>
    )
  }

  return (
    <div className="ac-rf">
      <style>{RESEARCH_FEED_CSS}</style>
      <h1 className="ac-rf__title">Research</h1>

      <div className="ac-rf__toolbar">
        <fieldset aria-label="verdict filter" className="ac-rf__filter">
          {["", "keep", "grey_area", "drop"].map((v) => (
            <Button
              key={v || "all"}
              type="button"
              size="sm"
              variant={verdictFilter === v ? "primary" : "ghost"}
              aria-pressed={verdictFilter === v}
              onClick={() => setVerdictFilter(v)}
            >
              {v === "" ? "All" : (VERDICT_LABELS[v] ?? v)}
            </Button>
          ))}
        </fieldset>
        <Checkbox
          checked={watchLiveOnly}
          onChange={(e) => setWatchLiveOnly(e.target.checked)}
          label="Watch live only"
        />
      </div>

      {!loaded ? <p className="ac-rf__note">Loading…</p> : null}
      {loaded && verdicts.length === 0 ? <EmptyState title="No verdicts yet." level={2} /> : null}

      {verdicts.length > 0 ? (
        <Card>
          <ul className="ac-rf__list">
            {verdicts.map((v) => (
              <li key={v.id} className="ac-rf__row">
                <div className="ac-rf__head">
                  <a className="ac-rf__link" href={v.url} target="_blank" rel="noreferrer">
                    {v.title ?? v.url}
                  </a>
                  <span className="ac-rf__meta">
                    <VerdictBadge verdict={v.verdict} />
                    {v.signalScore !== null ? (
                      <span className="ac-rf__score" title="signal score">
                        {v.signalScore}
                      </span>
                    ) : null}
                    {v.watchLive ? <Badge variant="info">watch live</Badge> : null}
                  </span>
                </div>
                {v.watchLive && v.watchLiveReason ? (
                  <p className="ac-rf__reason">{v.watchLiveReason}</p>
                ) : null}
                {v.summary ? <p className="ac-rf__summary">{v.summary}</p> : null}
                <div className="ac-rf__foot">
                  <time className="ac-rf__time" dateTime={v.gradedAt} title={v.gradedAt}>
                    {shortTime(v.gradedAt)}
                  </time>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-expanded={expandedId === v.id}
                    onClick={() => toggleExpand(v.id)}
                  >
                    {expandedId === v.id ? "Hide history" : "Show history"}
                  </Button>
                </div>
                {expandedId === v.id ? (
                  <ul aria-label={`history for ${v.id}`} className="ac-rf__history">
                    {history.map((h) => (
                      <li key={h.id} className="ac-rf__event">
                        <div className="ac-rf__event-head">
                          <time className="ac-rf__time" dateTime={h.gradedAt} title={h.gradedAt}>
                            {shortTime(h.gradedAt)}
                          </time>
                          <VerdictBadge verdict={h.verdict} />
                        </div>
                        {h.corrections.map((c) => (
                          <div key={c.createdAt} className="ac-rf__correction">
                            {c.correctedVerdict ? (
                              <span>
                                corrected to <VerdictBadge verdict={c.correctedVerdict} />
                              </span>
                            ) : null}
                            {c.note ? <span className="ac-rf__note-text">{c.note}</span> : null}
                          </div>
                        ))}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <form onSubmit={handleSubmit} className="ac-rf__submit">
          <Field className="ac-rf__submit-field">
            <Label htmlFor="research-feed-submit-url">Summarise this link</Label>
            <div className="ac-rf__submit-row">
              <Input
                id="research-feed-submit-url"
                type="url"
                placeholder="https://"
                value={submitUrl}
                onChange={(e) => setSubmitUrl(e.target.value)}
                required
              />
              <Button type="submit" variant="primary">
                Submit
              </Button>
            </div>
          </Field>
          {submitResult ? (
            <Alert variant={submitResult.ok ? "success" : "danger"}>{submitResult.text}</Alert>
          ) : null}
        </form>
      </Card>
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

  // Never its own heading or its own Card (an EmptyState is one): the console's home-cards wrapper
  // already renders `<Card><h3>{manifest title}</h3>...` around every card.
  if (isUnavailable(status)) {
    return (
      <div className="ac-rf-card">
        <style>{RESEARCH_FEED_CSS}</style>
        <p className="ac-rf-card__note">{UNAVAILABLE_MESSAGE}</p>
      </div>
    )
  }

  const watchLiveCount = verdicts.filter((v) => v.watchLive).length

  return (
    <div className="ac-rf-card">
      <style>{RESEARCH_FEED_CSS}</style>
      <p className="ac-rf-card__rollup">{watchLiveCount} watch live</p>
      <ul className="ac-rf-card__rows">
        {verdicts.slice(0, 5).map((v) => (
          <li key={v.id} className="ac-rf-card__row">
            <span
              className={`ac-rf-card__dot ac-rf-card__dot--${v.verdict}`}
              role="img"
              aria-label={VERDICT_LABELS[v.verdict] ?? v.verdict}
            />
            <a
              className="ac-rf-card__name"
              href={v.url}
              target="_blank"
              rel="noreferrer"
              title={v.title ?? v.url}
            >
              {v.title ?? v.url}
            </a>
            {v.watchLive ? <Badge variant="info">live</Badge> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Scoped CSS for what `@rackbops/ui-react` doesn't cover -- the verdict list rows, the history
 *  timeline and the card's compact rows. Colours are the semantic `--rb-*` tokens the console's
 *  `rb-badge--success/warning/danger` resolve to, so a card dot and a panel badge always agree. */
const RESEARCH_FEED_CSS = `
.ac-rf { color: var(--rb-text); display: flex; flex-direction: column; gap: var(--rb-space-3); }
.ac-rf__title { margin: 0; }
.ac-rf__note { color: var(--rb-text-faint); font-size: 12px; margin: 0; }
.ac-rf__toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--rb-space-3); }
.ac-rf__filter { display: inline-flex; flex-wrap: wrap; gap: var(--rb-space-1); border: 0; margin: 0; padding: 0; min-width: 0; }
.ac-rf__list { list-style: none; margin: 0; padding: 0; }
.ac-rf__row { padding: var(--rb-space-3) 0; border-bottom: 1px solid var(--rb-border); display: flex; flex-direction: column; gap: var(--rb-space-1); }
.ac-rf__row:first-child { padding-top: 0; }
.ac-rf__row:last-child { border-bottom: 0; padding-bottom: 0; }
.ac-rf__head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: var(--rb-space-2); }
.ac-rf__link { color: var(--rb-accent); font-weight: var(--rb-font-weight-bold, 600); overflow-wrap: anywhere; min-width: 0; }
.ac-rf__meta { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: var(--rb-space-2); }
.ac-rf__score { font-family: var(--rb-font-mono); font-size: 12px; color: var(--rb-text-soft); }
.ac-rf__reason { margin: 0; font-size: 12px; color: var(--rb-text-soft); }
.ac-rf__summary { margin: 0; font-size: var(--rb-text-sm, 13px); color: var(--rb-text-soft); line-height: 1.45; }
.ac-rf__foot { display: flex; align-items: center; justify-content: space-between; gap: var(--rb-space-2); }
.ac-rf__time { font-family: var(--rb-font-mono); font-size: 11px; color: var(--rb-text-faint); }
.ac-rf__history { list-style: none; margin: var(--rb-space-1) 0 0; padding: 0 0 0 var(--rb-space-3); border-left: 2px solid var(--rb-border); display: flex; flex-direction: column; gap: var(--rb-space-2); }
.ac-rf__event { display: flex; flex-direction: column; gap: var(--rb-space-1); font-size: 12px; }
.ac-rf__event-head { display: flex; align-items: center; gap: var(--rb-space-2); }
.ac-rf__correction { display: flex; flex-wrap: wrap; align-items: center; gap: var(--rb-space-2); color: var(--rb-text-soft); }
.ac-rf__note-text { font-style: italic; overflow-wrap: anywhere; }
.ac-rf__submit { display: flex; flex-direction: column; gap: var(--rb-space-2); }
.ac-rf__submit-field { margin: 0; }
.ac-rf__submit-row { display: flex; flex-wrap: wrap; gap: var(--rb-space-2); }
.ac-rf__submit-row .rb-input { flex: 1 1 16rem; min-width: 0; }
.ac-rf-card__rollup { margin: 0 0 var(--rb-space-2); font-size: 0.85em; color: var(--rb-text-faint); }
.ac-rf-card__note { margin: 0; font-size: 12px; color: var(--rb-text-faint); }
.ac-rf-card__rows { list-style: none; margin: 0; padding: 0; }
.ac-rf-card__row { display: flex; align-items: center; gap: var(--rb-space-2); padding: var(--rb-space-1) 0; font-size: 0.85em; }
.ac-rf-card__dot { flex: none; width: 0.55em; height: 0.55em; border-radius: 50%; background: var(--rb-text-faint); }
.ac-rf-card__dot--keep { background: var(--rb-success); }
.ac-rf-card__dot--grey_area { background: var(--rb-warning); }
.ac-rf-card__dot--drop { background: var(--rb-danger); }
.ac-rf-card__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--rb-text); }
`
