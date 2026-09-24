#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

/**
 * Drives the `sidecar-smoke` CI job (#453): boots a real `research-feed-store` container image
 * (built, not pushed, by the job's earlier step) against `scripts/feed-stub.mjs` running on the
 * runner, and proves the properties a unit test can't: a real container restart keeps its rows, a
 * real `docker history`/`docker inspect` of the IMAGE never carries the sentinel credential while
 * the CONTAINER's own env genuinely does (so the grep is proven real, not vacuous), and the health/
 * unreachable/submit behavior holds end to end.
 *
 * Assumes: `docker` on PATH, the image already built and tagged (argv[2], e.g.
 * `research-feed-store:ci`), and this script running from the repo root (feed-stub.mjs is a
 * sibling). Exits non-zero and prints a `+`/`x`-prefixed step log on any assertion failure --
 * `check-typecheck-covers-tests.mjs`'s convention doesn't apply here (this isn't a vitest file: no
 * Docker on the dev box, so it can only ever run inside the CI job -- see the repo's CLAUDE.md "Key
 * gotchas" precedent for a CI-only smoke script living outside the workspace's own typecheck/test
 * graph).
 */

const IMAGE = process.argv[2]
if (!IMAGE) {
  console.error("usage: node scripts/sidecar-smoke.mjs <image-tag>")
  process.exit(1)
}

const SENTINEL = "rtf_CI_SENTINEL_do_not_ship"
const CONTAINER_NAME = "research-feed-store-smoke"
const VOLUME_NAME = "research-feed-store-smoke-data"
const CONTAINER_PORT = 18123
const STUB_PORT = 18124

let failures = 0
let stubProc

function step(name) {
  process.stdout.write(`\n== ${name}\n`)
}

function ok(name) {
  process.stdout.write(`+ ${name}\n`)
}

function fail(name, detail) {
  failures++
  process.stderr.write(`x ${name}${detail ? `: ${detail}` : ""}\n`)
}

async function assertTrue(name, condition, detail) {
  if (condition) ok(name)
  else fail(name, detail)
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts })
}

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result) return result
    } catch (err) {
      lastErr = err
    }
    await delay(intervalMs)
  }
  throw new Error(`waitFor timed out${lastErr ? `: ${lastErr.message}` : ""}`)
}

const feedStubPath = fileURLToPath(new URL("./feed-stub.mjs", import.meta.url))

function startStub() {
  stubProc = spawn(
    process.execPath,
    [feedStubPath, "--port", String(STUB_PORT), "--token", SENTINEL],
    { stdio: "inherit" },
  )
}

function stopStub() {
  if (stubProc && !stubProc.killed) {
    stubProc.kill("SIGTERM")
    stubProc = undefined
  }
}

function dockerRun() {
  run("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--add-host=host.docker.internal:host-gateway",
    "-p",
    `${CONTAINER_PORT}:8000`,
    "-v",
    `${VOLUME_NAME}:/data`,
    "-e",
    `RESEARCH_FEED_URL=http://host.docker.internal:${STUB_PORT}`,
    "-e",
    `RESEARCH_FEED_TOKEN=${SENTINEL}`,
    "-e",
    "RESEARCH_FEED_POLL_SECONDS=30",
    "-e",
    "RESEARCH_FEED_TEST_HOOKS=1",
    IMAGE,
  ])
}

function cleanup() {
  stopStub()
  try {
    run("docker", ["rm", "-f", CONTAINER_NAME])
  } catch {
    // already gone
  }
  try {
    run("docker", ["volume", "rm", "-f", VOLUME_NAME])
  } catch {
    // already gone
  }
}

const base = () => `http://127.0.0.1:${CONTAINER_PORT}`

async function triggerPoll() {
  await fetchJson(`${base()}/__poll`, { method: "POST" })
}

async function main() {
  process.on("exit", cleanup)

  step("start the feed stub on the runner")
  startStub()
  await waitFor(async () => {
    // Any response (even the stub's own 401/404) proves the listener is up -- this deliberately
    // does not insert a grading, so the store's later item-count assertions aren't polluted.
    try {
      await fetch(`http://127.0.0.1:${STUB_PORT}/__ready-check`, { method: "GET" })
      return true
    } catch {
      return false
    }
  })
  ok("feed stub is up")

  step("start the research-feed-store container")
  dockerRun()
  const first = await waitFor(async () => {
    const { status, body } = await fetchJson(`${base()}/healthz`)
    return status === 200 && body.feed?.state === "ok" ? body : undefined
  })
  await assertTrue(
    "/healthz is 200 with feed.state ok after the first poll",
    first.feed.state === "ok",
  )

  step("add a grading, trigger a poll, /verdicts lists it once")
  const { body: added } = await fetchJson(`http://127.0.0.1:${STUB_PORT}/__add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "smoke-1",
      url: "https://example.com/smoke-1",
      title: "Smoke test video",
      verdict: "keep",
      watchLive: true,
      watchLiveReason: "live now",
    }),
  })
  await triggerPoll()
  let verdictsBody = (await fetchJson(`${base()}/verdicts`)).body
  const matches = () => verdictsBody.verdicts.filter((v) => v.id === "smoke-1")
  await assertTrue(
    "the grading appears exactly once",
    matches().length === 1,
    JSON.stringify(matches()),
  )

  await triggerPoll() // a second poll must not duplicate it
  verdictsBody = (await fetchJson(`${base()}/verdicts`)).body
  await assertTrue("a second poll doesn't duplicate it", matches().length === 1)

  step("a correction re-surfaces the row with its correction")
  await fetchJson(`http://127.0.0.1:${STUB_PORT}/__correct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: added.grading.id,
      correction: { correctedVerdict: "drop", note: "smoke correction" },
    }),
  })
  await triggerPoll()
  const detail = (await fetchJson(`${base()}/verdicts/${added.grading.id}`)).body
  await assertTrue(
    "the correction is present",
    detail.verdict?.corrections?.some((c) => c.note === "smoke correction"),
    JSON.stringify(detail),
  )

  step("POST /submit relays the stub's 202")
  const submitRes = await fetchJson(`${base()}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/submitted" }),
  })
  await assertTrue("/submit relays 202", submitRes.status === 202, JSON.stringify(submitRes))

  step("docker restart -- rows survive")
  run("docker", ["restart", CONTAINER_NAME])
  await waitFor(async () => {
    const { status } = await fetchJson(`${base()}/healthz`)
    return status === 200
  })
  const afterRestart = (await fetchJson(`${base()}/verdicts/${added.grading.id}`)).body
  await assertTrue(
    "the grading is still there after a container restart",
    afterRestart.verdict?.id === added.grading.id,
  )

  step(
    "stop the stub -- the next poll marks unreachable, /healthz stays 200, /verdicts still serves",
  )
  stopStub()
  await waitFor(async () => {
    await triggerPoll()
    const { body } = await fetchJson(`${base()}/healthz`)
    return body.feed?.state === "unreachable" ? body : undefined
  })
  const afterStop = await fetchJson(`${base()}/healthz`)
  await assertTrue("/healthz is still 200 while unreachable", afterStop.status === 200)
  const stillServes = await fetchJson(`${base()}/verdicts/${added.grading.id}`)
  await assertTrue("/verdicts still serves while unreachable", stillServes.status === 200)

  step("no sentinel credential in the IMAGE's history or inspect")
  const imageHistory = run("docker", ["history", "--no-trunc", IMAGE])
  await assertTrue("docker history (image) carries no sentinel", !imageHistory.includes(SENTINEL))
  const imageInspect = run("docker", ["inspect", IMAGE])
  await assertTrue("docker inspect (image) carries no sentinel", !imageInspect.includes(SENTINEL))

  step("the sentinel IS in the container's own env (proves the grep above is real, not vacuous)")
  const containerInspect = run("docker", ["inspect", CONTAINER_NAME])
  await assertTrue(
    "docker inspect (container) DOES carry the sentinel",
    containerInspect.includes(SENTINEL),
  )

  if (failures > 0) {
    console.error(`\n${failures} sidecar-smoke assertion(s) failed`)
    process.exitCode = 1
  } else {
    process.stdout.write("\n+ sidecar-smoke passed\n")
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
