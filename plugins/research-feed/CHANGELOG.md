# Changelog

## [0.3.0] - 2026-09-25

The panel and card now match the console's look: they use `@rackbops/ui-react` (an import-map
external, so `dist/ui.js` stays self-contained) and the console's `--rb-*` theme tokens. Verdicts
show as coloured badges in the theme's success, warning and danger colours (Keep, Grey area,
Drop). The verdict filter is a row of small buttons, with the active one highlighted. Each link
is a row with a divider, its signal score, a "watch live" badge and reason, and when it was
graded. A link's history is an indented timeline. The "Summarise this link" form is a themed
field and button, with a success or error alert for the result. While the list loads, the panel
says "Loading…". The Overview card shows a coloured dot per verdict, and each title now links to
the page. Two texts read differently: a correction shows "corrected to" and a verdict badge
instead of the raw verdict value, and a watch-live reason sits on its own line below the title
instead of after "watch live:". When the sidecar is unreachable, the panel shows the same message
as a warning alert. The requests the panel and card make, the filters, history and submit are
unchanged.

## [0.2.0] - 2026-09-25

No functional change. The first version CI publishes through the trusted publisher, and the
upgrade target for the pin-an-older-version check from the console's Admin card (#108, #106).

## [0.1.0] - 2026-09-24

First release: the `research` panel and `research-feed-card` Overview card, proxying the
`research-feed-store` sidecar (`host.sidecar.baseUrl`). Browse graded links, filter by
verdict/watch-live, expand a link's grading history, and submit a URL for grading. Any sidecar
failure degrades to the empty state -- the console stays healthy either way (#106).
