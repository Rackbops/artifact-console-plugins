# Changelog

## [0.1.0] - 2026-09-24

First release: mirrors the research-triage machine feed (`GET /api/feed/gradings`) into local
SQLite, surviving research-triage outages and container restarts. `GET /healthz`,
`GET /verdicts[?verdict=&watchLive=&limit=]`, `GET /verdicts/:id`, `GET /history[?limit=]`,
`POST /submit`. Proves the sidecar (`kind: "sidecar"`) install path end to end (#453).
