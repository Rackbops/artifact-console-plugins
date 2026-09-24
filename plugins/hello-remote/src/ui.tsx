import { fetch as hostFetch } from "@ac/host"
import { useEffect, useState } from "react"

/**
 * `plugins/hello-remote`'s frontend bundle (`dist/ui.js`, served at `/plugins-assets/hello-remote`).
 * It imports only `react` and `@ac/host` — two of the host's seven import-map specifiers — so `tsc`
 * emits an ESM with React unbundled, the same rule every in-process plugin's frontend follows.
 */
export function HelloRemotePanel() {
  const [greeting, setGreeting] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    hostFetch("/api/x/hello-remote/ping")
      .then((res) => res.json())
      .then((body: { greeting?: string }) => {
        if (!cancelled) setGreeting(body.greeting ?? null)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <h1>Hello from a remote plugin</h1>
      {failed ? <p>unavailable</p> : <p>{greeting ?? "loading..."}</p>}
    </div>
  )
}

export function HelloRemoteCard() {
  return <div>Installed from the artifact-console-plugins index.</div>
}
