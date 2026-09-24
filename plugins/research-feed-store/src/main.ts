import { createServer } from "node:http"
import { readConfig, redactedConfig } from "./config.js"
import { createHandler } from "./http.js"
import { startPoller } from "./poller.js"
import { openStore } from "./store.js"

const PORT = 8000
const HOST = "0.0.0.0"

function log(message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message
  console.log(`[research-feed-store] ${line}`)
}

function main(): void {
  const config = readConfig(process.env)
  log("starting", redactedConfig(config))

  const store = openStore(config.dbPath)
  const poller = startPoller(config, store)

  const handler = createHandler({
    store,
    config,
    fetchFn: fetch,
    triggerPoll: config.testHooks ? () => poller.tick() : undefined,
  })

  const server = createServer(handler)
  server.listen(PORT, HOST, () => {
    log(`listening on ${HOST}:${PORT}`)
  })

  const shutdown = (signal: string): void => {
    log(`received ${signal}, shutting down`)
    poller.stop()
    server.close(() => {
      store.close()
      process.exit(0)
    })
    // Force-exit if close hangs (e.g. a slow in-flight request).
    setTimeout(() => process.exit(0), 5000).unref()
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main()
