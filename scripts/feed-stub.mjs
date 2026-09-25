#!/usr/bin/env node
import { createServer } from "node:http"

/**
 * A dependency-free, in-memory stand-in for research-triage's machine feed (#453). Used by
 * research-feed-store's own tests and by the CI `sidecar-smoke` job to drive a real container
 * against a real (if fake) upstream, with no network dependency on the real rt.rackbops.com.
 *
 * Implements the real paging/cursor contract (research-triage#320/#343): `GET
 * /api/feed/gradings?since=&limit=` returns items with cursor > since, ordered by cursor ascending,
 * capped at limit; `nextCursor` equals the last returned item's cursor, or `since` unchanged when
 * the page is empty. `POST /api/feed/submit { url }` answers 202 for a well-formed http(s) url, 400
 * otherwise. Both require `Authorization: Bearer <token>`; with `--require-access`, both ALSO
 * require `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers matching the configured pair.
 *
 * Two test-only routes: `POST /__add` (append a grading, auto-assigning the next cursor) and
 * `POST /__correct { id, correction }` (re-cursor an existing grading and push the correction onto
 * its corrections[] -- "a correction re-surfaces a grading with a new cursor").
 *
 * CLI: --port <n> (default 0, ephemeral), --token <bearer>, --require-access,
 * --cf-client-id <id>, --cf-client-secret <secret>. Also readable from env:
 * FEED_STUB_PORT/FEED_STUB_TOKEN/FEED_STUB_REQUIRE_ACCESS/FEED_STUB_CF_CLIENT_ID/
 * FEED_STUB_CF_CLIENT_SECRET.
 */

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--require-access") {
      out.requireAccess = true
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2)
      out[key] = argv[++i]
    }
  }
  return out
}

export function createFeedStub(opts = {}) {
  const token = opts.token ?? process.env.FEED_STUB_TOKEN ?? "rtf_stub_token"
  const requireAccess = opts.requireAccess ?? process.env.FEED_STUB_REQUIRE_ACCESS === "1"
  const cfClientId = opts.cfClientId ?? process.env.FEED_STUB_CF_CLIENT_ID ?? "stub-cf-id"
  const cfClientSecret =
    opts.cfClientSecret ?? process.env.FEED_STUB_CF_CLIENT_SECRET ?? "stub-cf-secret"

  /** @type {Array<Record<string, unknown>>} */
  const gradings = []
  let cursorCounter = 0

  function nextCursor() {
    cursorCounter += 1
    return String(cursorCounter)
  }

  function isAuthorized(req) {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${token}`) return false
    if (requireAccess) {
      if (req.headers["cf-access-client-id"] !== cfClientId) return false
      if (req.headers["cf-access-client-secret"] !== cfClientSecret) return false
    }
    return true
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    res.end(text)
  }

  async function readJson(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString("utf8")
    return text.length > 0 ? JSON.parse(text) : {}
  }

  function handleGradings(req, res, url) {
    const since = Number(url.searchParams.get("since") ?? "0")
    const rawLimit = Number(url.searchParams.get("limit") ?? "100")
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 500))
    if (!Number.isFinite(since)) {
      return sendJson(res, 400, { ok: false, error: "malformed since" })
    }
    const matching = gradings
      .filter((g) => Number(g.cursor) > since)
      .sort((a, b) => Number(a.cursor) - Number(b.cursor))
      .slice(0, limit)
    const nextCursorValue =
      matching.length > 0
        ? matching[matching.length - 1].cursor
        : (url.searchParams.get("since") ?? "0")
    return sendJson(res, 200, { items: matching, nextCursor: nextCursorValue })
  }

  async function handleSubmit(req, res) {
    let body
    try {
      body = await readJson(req)
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" })
    }
    if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) {
      return sendJson(res, 400, { error: "url must be an http(s) url" })
    }
    return sendJson(res, 202, { accepted: true, url: body.url })
  }

  async function handleAdd(req, res) {
    const body = await readJson(req)
    const grading = {
      id: body.id ?? `g${cursorCounter + 1}`,
      cursor: nextCursor(),
      kind: body.kind ?? "video",
      title: body.title ?? null,
      url: body.url,
      verdict: body.verdict ?? "keep",
      signalScore: body.signalScore ?? null,
      summary: body.summary ?? null,
      keyTakeaways: body.keyTakeaways ?? [],
      watchLive: body.watchLive ?? false,
      watchLiveReason: body.watchLiveReason ?? null,
      gradedAt: body.gradedAt ?? new Date().toISOString(),
      corrections: body.corrections ?? [],
    }
    gradings.push(grading)
    return sendJson(res, 200, { ok: true, grading })
  }

  async function handleCorrect(req, res) {
    const body = await readJson(req)
    const grading = gradings.find((g) => g.id === body.id)
    if (!grading) return sendJson(res, 404, { ok: false, error: "unknown id" })
    grading.cursor = nextCursor()
    grading.corrections = [
      ...(grading.corrections ?? []),
      { createdAt: new Date().toISOString(), ...body.correction },
    ]
    return sendJson(res, 200, { ok: true, grading })
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://internal")
      try {
        if (url.pathname === "/__add" && req.method === "POST") return await handleAdd(req, res)
        if (url.pathname === "/__correct" && req.method === "POST")
          return await handleCorrect(req, res)

        if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" })

        if (url.pathname === "/api/feed/gradings" && req.method === "GET") {
          return handleGradings(req, res, url)
        }
        if (url.pathname === "/api/feed/submit" && req.method === "POST") {
          return await handleSubmit(req, res)
        }
        return sendJson(res, 404, { error: "not found" })
      } catch (err) {
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    })()
  })

  return { server, gradings }
}

if (process.argv[1] && process.argv[1].endsWith("feed-stub.mjs")) {
  const args = parseArgs(process.argv.slice(2))
  const port = Number(args.port ?? process.env.FEED_STUB_PORT ?? 0)
  const { server } = createFeedStub({
    token: args.token,
    requireAccess: args["require-access"] === undefined ? undefined : true,
    cfClientId: args["cf-client-id"],
    cfClientSecret: args["cf-client-secret"],
  })
  server.listen(port, "0.0.0.0", () => {
    const address = server.address()
    const actualPort = typeof address === "object" && address ? address.port : port
    process.stdout.write(`feed-stub listening on 0.0.0.0:${actualPort}\n`)
  })
}
