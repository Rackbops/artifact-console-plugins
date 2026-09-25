import { expect, test } from "vitest"
import { feedHeaders, readConfig, redactedConfig } from "./config.js"

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides }
}

test("readConfig rejects a relative db path", () => {
  expect(() => readConfig(env({ RESEARCH_FEED_DB: "relative/path.db" }))).toThrow(
    /must be an absolute path/,
  )
})

test("readConfig rejects a poll interval under 30", () => {
  expect(() => readConfig(env({ RESEARCH_FEED_POLL_SECONDS: "29" }))).toThrow(
    /must be a number >= 30/,
  )
  expect(() => readConfig(env({ RESEARCH_FEED_POLL_SECONDS: "not-a-number" }))).toThrow(
    /must be a number >= 30/,
  )
})

test("readConfig accepts a poll interval of exactly 30", () => {
  expect(() => readConfig(env({ RESEARCH_FEED_POLL_SECONDS: "30" }))).not.toThrow()
})

test("readConfig reports unconfigured without RESEARCH_FEED_URL or RESEARCH_FEED_TOKEN", () => {
  expect(readConfig(env()).configured).toBe(false)
  expect(readConfig(env({ RESEARCH_FEED_URL: "https://rt.example" })).configured).toBe(false)
  expect(readConfig(env({ RESEARCH_FEED_TOKEN: "rtf_x" })).configured).toBe(false)
  expect(
    readConfig(env({ RESEARCH_FEED_URL: "https://rt.example", RESEARCH_FEED_TOKEN: "rtf_x" }))
      .configured,
  ).toBe(true)
})

test("readConfig rejects one Access credential set without the other", () => {
  expect(() => readConfig(env({ RESEARCH_FEED_ACCESS_CLIENT_ID: "id-only" }))).toThrow(
    /must be set together/,
  )
  expect(() => readConfig(env({ RESEARCH_FEED_ACCESS_CLIENT_SECRET: "secret-only" }))).toThrow(
    /must be set together/,
  )
})

test("readConfig applies defaults with no env set", () => {
  const config = readConfig(env())
  expect(config.pollSeconds).toBe(300)
  expect(config.dbPath).toBe("/data/research-feed.db")
  expect(config.testHooks).toBe(false)
})

test("feedHeaders sends only the bearer when Access credentials are unset", () => {
  const config = readConfig(
    env({ RESEARCH_FEED_URL: "https://rt.example", RESEARCH_FEED_TOKEN: "rtf_x" }),
  )
  expect(feedHeaders(config)).toEqual({ Authorization: "Bearer rtf_x" })
})

test("feedHeaders sends the bearer and both CF-Access headers when set", () => {
  const config = readConfig(
    env({
      RESEARCH_FEED_URL: "https://rt.example",
      RESEARCH_FEED_TOKEN: "rtf_x",
      RESEARCH_FEED_ACCESS_CLIENT_ID: "cid",
      RESEARCH_FEED_ACCESS_CLIENT_SECRET: "csecret",
    }),
  )
  expect(feedHeaders(config)).toEqual({
    Authorization: "Bearer rtf_x",
    "CF-Access-Client-Id": "cid",
    "CF-Access-Client-Secret": "csecret",
  })
})

test("redactedConfig never includes a raw secret value", () => {
  const config = readConfig(
    env({
      RESEARCH_FEED_URL: "https://rt.example",
      RESEARCH_FEED_TOKEN: "rtf_super_secret",
      RESEARCH_FEED_ACCESS_CLIENT_ID: "cid",
      RESEARCH_FEED_ACCESS_CLIENT_SECRET: "csecret",
    }),
  )
  const redacted = JSON.stringify(redactedConfig(config))
  expect(redacted).not.toContain("rtf_super_secret")
  expect(redacted).not.toContain("cid")
  expect(redacted).not.toContain("csecret")
  expect(redacted).toContain('"feedTokenSet":true')
})
