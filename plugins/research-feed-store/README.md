# @rackbops/ac-plugin-research-feed-store

A `kind: "sidecar"` [artifact-console-plugins](../../README.md) package: no `dist/` on npm at all
(the manifest ships in `package.json`; `files: []`). What ships is a container image,
`ghcr.io/rackbops/ac-research-feed-store`, built by `publish.yml` alongside the npm publish and
proxied by the host at `/api/x/research-feed-store/*` once installed.

## What it mirrors

It polls research-triage's machine feed (`GET /api/feed/gradings`, `docs/deploy.md` "Machine
feed") into a local SQLite file, so the console's `research-feed` plugin keeps serving verdicts
even while research-triage or the network between them is down, and never loses a grading across a
container restart.

## Routes

- `GET /healthz` -- always 200 while the process is up: `{ ok: true, feed: { state, lastAttemptAt,
  lastSuccessAt, error? }, mirrored: <row count> }`. `state` is `"ok"`, `"unreachable"` or
  `"unconfigured"`.
- `GET /verdicts?verdict=&watchLive=&limit=` -- the latest grading per url.
- `GET /verdicts/:id` -- one grading plus every grading sharing its url (its full history).
- `GET /history?limit=` -- every grading, newest first.
- `POST /submit { url }` -- relays to research-triage's own submit endpoint; `503 { ok: false,
  error }` when unconfigured or unreachable, never 502/504.

## Env keys

All runtime-only -- nothing here is ever baked into the image.

| Key | Required | Notes |
|---|---|---|
| `RESEARCH_FEED_URL` | yes | The feed's origin, e.g. `https://rt.rackbops.com`. |
| `RESEARCH_FEED_TOKEN` | yes | Bearer token (`npm run feed:mint-token` in research-triage). |
| `RESEARCH_FEED_ACCESS_CLIENT_ID` | no | Cloudflare Access service token id. |
| `RESEARCH_FEED_ACCESS_CLIENT_SECRET` | no | Cloudflare Access service token secret. |
| `RESEARCH_FEED_POLL_SECONDS` | no | Default 300, minimum 30. |
| `RESEARCH_FEED_DB` | no | Absolute path, default `/data/research-feed.db`. |

Without `RESEARCH_FEED_URL`/`RESEARCH_FEED_TOKEN` the sidecar runs "unconfigured": `/healthz`
still answers 200 and `/verdicts`/`/history` still serve whatever is already mirrored (empty on a
fresh volume).

## Operator setup

1. In research-triage, mint the bearer: `npm run feed:mint-token`.
2. Under `rt.rackbops.com`'s Cloudflare Access `non_identity` policy, mint a service token
   (Client Id + Secret).
3. Copy `deploy/research-feed-store.env.example` to `research-feed-store.env` next to your
   `compose.yaml`, fill in the four feed keys, then `chmod 600 research-feed-store.env`.
4. Append `deploy/compose.fragment.yaml` to your `compose.yaml`.
5. `docker compose up -d research-feed-store`.

## Install into a console

See the repo root [README](../../README.md#installing-from-a-console) -- install this alongside
`@rackbops/ac-plugin-research-feed` (the in-process panel/card that reads it), matched
`0.1.0`/`0.1.0` versions.
