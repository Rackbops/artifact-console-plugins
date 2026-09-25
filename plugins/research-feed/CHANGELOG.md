# Changelog

## [0.2.0] - 2026-09-25

No functional change. The first version CI publishes through the trusted publisher, and the
upgrade target for the pin-an-older-version check from the console's Admin card (#108, #106).

## [0.1.0] - 2026-09-24

First release: the `research` panel and `research-feed-card` Overview card, proxying the
`research-feed-store` sidecar (`host.sidecar.baseUrl`). Browse graded links, filter by
verdict/watch-live, expand a link's grading history, and submit a URL for grading. Any sidecar
failure degrades to the empty state -- the console stays healthy either way (#106).
