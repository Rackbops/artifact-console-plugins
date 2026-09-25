# Changelog

## [0.1.1] - 2026-09-25

No functional change. The first version CI publishes: its tag builds and pushes
`ghcr.io/rackbops/ac-research-feed-store:0.1.1`, the image `deploy/compose.fragment.yaml` pins
(0.1.0 was the one-time manual npm bootstrap, so no 0.1.0 image exists).

## [0.1.0] - 2026-09-24

First release: mirrors the research-triage machine feed (`GET /api/feed/gradings`) into local
SQLite, surviving research-triage outages and container restarts. `GET /healthz`,
`GET /verdicts[?verdict=&watchLive=&limit=]`, `GET /verdicts/:id`, `GET /history[?limit=]`,
`POST /submit`. Proves the sidecar (`kind: "sidecar"`) install path end to end (#453).
