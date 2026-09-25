/**
 * Env parsing for the research-feed-store sidecar (#453 decision 2). Pure -- `readConfig(env)`
 * takes a plain env map so it's testable with no process-global mutation. Every credential is
 * runtime-only: nothing here is ever baked into the image (the Dockerfile carries no ARG/ENV/LABEL
 * naming any of these keys -- see the Dockerfile's own comment and
 * `Dockerfile declares no ARG, ENV or LABEL naming a RESEARCH_FEED credential`).
 */

export const DEFAULT_POLL_SECONDS = 300
export const MIN_POLL_SECONDS = 30
export const DEFAULT_DB_PATH = "/data/research-feed.db"

export interface Config {
  /** The feed's origin, e.g. "https://rt.rackbops.com". Undefined when unset/blank. */
  feedUrl: string | undefined
  /** The bearer token (`Authorization: Bearer <token>`). Undefined when unset/blank. */
  feedToken: string | undefined
  /** The Cloudflare Access service token pair -- optional; a stub feed doesn't need them. Either
   *  both are set or neither is (see readConfig for the "one without the other" refusal). */
  accessClientId: string | undefined
  accessClientSecret: string | undefined
  /** Poll interval in seconds; >= MIN_POLL_SECONDS. */
  pollSeconds: number
  /** Absolute path to the SQLite db file. */
  dbPath: string
  /** RESEARCH_FEED_TEST_HOOKS=1 exposes POST /__poll for the CI smoke (30s is the real minimum
   *  interval, so the smoke needs a way to trigger a poll on demand). */
  testHooks: boolean
  /** True when both feedUrl and feedToken are set -- the CF Access pair is optional. */
  configured: boolean
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const feedUrl = nonBlank(env.RESEARCH_FEED_URL)
  const feedToken = nonBlank(env.RESEARCH_FEED_TOKEN)
  const accessClientId = nonBlank(env.RESEARCH_FEED_ACCESS_CLIENT_ID)
  const accessClientSecret = nonBlank(env.RESEARCH_FEED_ACCESS_CLIENT_SECRET)
  if ((accessClientId === undefined) !== (accessClientSecret === undefined)) {
    throw new Error(
      "RESEARCH_FEED_ACCESS_CLIENT_ID and RESEARCH_FEED_ACCESS_CLIENT_SECRET must be set together " +
        "or not at all",
    )
  }

  const dbPath = nonBlank(env.RESEARCH_FEED_DB) ?? DEFAULT_DB_PATH
  if (!dbPath.startsWith("/")) {
    throw new Error(`RESEARCH_FEED_DB must be an absolute path, got "${dbPath}"`)
  }

  const pollRaw = nonBlank(env.RESEARCH_FEED_POLL_SECONDS)
  const pollSeconds = pollRaw === undefined ? DEFAULT_POLL_SECONDS : Number(pollRaw)
  if (!Number.isFinite(pollSeconds) || pollSeconds < MIN_POLL_SECONDS) {
    throw new Error(
      `RESEARCH_FEED_POLL_SECONDS must be a number >= ${MIN_POLL_SECONDS}, got "${pollRaw}"`,
    )
  }

  return {
    feedUrl,
    feedToken,
    accessClientId,
    accessClientSecret,
    pollSeconds,
    dbPath,
    testHooks: env.RESEARCH_FEED_TEST_HOOKS === "1",
    configured: feedUrl !== undefined && feedToken !== undefined,
  }
}

/** The headers pollOnce/submit send: the bearer always when configured, both CF-Access headers only
 *  when both are set (#453 verified-at-pickup bullet: "so the sidecar needs four env keys"). */
export function feedHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {}
  if (config.feedToken) headers.Authorization = `Bearer ${config.feedToken}`
  if (config.accessClientId && config.accessClientSecret) {
    headers["CF-Access-Client-Id"] = config.accessClientId
    headers["CF-Access-Client-Secret"] = config.accessClientSecret
  }
  return headers
}

/** Logs the config with no secret VALUES -- only whether each is set (main.ts's own rule). */
export function redactedConfig(config: Config): Record<string, unknown> {
  return {
    feedUrl: config.feedUrl ?? null,
    feedTokenSet: config.feedToken !== undefined,
    accessClientIdSet: config.accessClientId !== undefined,
    accessClientSecretSet: config.accessClientSecret !== undefined,
    pollSeconds: config.pollSeconds,
    dbPath: config.dbPath,
    testHooks: config.testHooks,
    configured: config.configured,
  }
}
