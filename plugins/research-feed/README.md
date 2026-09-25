# @rackbops/ac-plugin-research-feed

The in-process half of the research feed (#106): a `research` panel and a `research-feed-card`
Overview card (`sizes: ["1x3"]`), both reading the `@rackbops/ac-plugin-research-feed-store`
sidecar through `host.sidecar.baseUrl("research-feed-store")` -- see that plugin's own
[README](../research-feed-store/README.md) for what it mirrors and how to deploy it.

## Routes

Every route is a thin, 5s-timeout proxy to the sidecar; any sidecar failure (timeout, connection
refused, a non-JSON response) answers `503 { ok: false, available: false, reason }` -- the UI
treats `available: false` as the empty state, so nothing this plugin does can take the console
down.

- `GET /status` -- the sidecar's `/healthz` body, or the unavailable shape above.
- `GET /verdicts?verdict=&watchLive=&limit=` -- passes only those three query params through.
- `GET /verdicts/:id` -- one grading plus its full history.
- `GET /history?limit=`
- `POST /submit { url }` -- forwards to the sidecar's own `/submit`, which relays research-triage's
  outcome.

## Install into a console

Install this alongside `@rackbops/ac-plugin-research-feed-store` (matched versions) -- see the
[repo root README](../../README.md#installing-from-a-console).
