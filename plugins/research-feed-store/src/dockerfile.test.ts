import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

// Text scan: the Dockerfile must declare no ARG, ENV or LABEL naming any RESEARCH_FEED credential
// -- every credential is runtime-only (decision 2/8), supplied at `docker run`/compose via
// env_file, never baked into an image layer.

const dockerfilePath = fileURLToPath(new URL("../Dockerfile", import.meta.url))

test("Dockerfile declares no ARG, ENV or LABEL naming a RESEARCH_FEED credential", () => {
  const text = readFileSync(dockerfilePath, "utf8")
  const declLines = text.split(/\r?\n/).filter((line) => /^\s*(ARG|ENV|LABEL)\b/i.test(line))
  for (const line of declLines) {
    expect(line).not.toMatch(/RESEARCH_FEED/)
  }
})

test("Dockerfile declares no ARG, ENV or LABEL at all naming a credential-shaped key", () => {
  const text = readFileSync(dockerfilePath, "utf8")
  expect(text).not.toMatch(
    /\b(ARG|ENV|LABEL)\s+RESEARCH_FEED_(URL|TOKEN|ACCESS_CLIENT_ID|ACCESS_CLIENT_SECRET|POLL_SECONDS|DB)\b/,
  )
})

// ---- pinned base and build tools (#22) --------------------------------------------------------

const lockfilePath = fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url))

test("both FROM lines name an exact node:<major>.<minor>.<patch>-slim tag", () => {
  const text = readFileSync(dockerfilePath, "utf8")
  const froms = text.split(/\r?\n/).filter((line) => /^FROM\s/i.test(line))
  expect(froms).toHaveLength(2)
  for (const line of froms) {
    expect(line).toMatch(/^FROM node:\d+\.\d+\.\d+-slim(@sha256:[0-9a-f]{64})? AS \w+$/)
  }
})

test("the RUN line's typescript and @types/node equal the lockfile's resolved versions", () => {
  const text = readFileSync(dockerfilePath, "utf8")
  const run = text.split(/\r?\n/).find((line) => /^RUN npm install\b/.test(line))
  expect(run).toBeDefined()
  const lock = readFileSync(lockfilePath, "utf8")
  for (const pkg of ["typescript", "@types/node"]) {
    const pinned = new RegExp(`\\s${pkg}@(\\d+\\.\\d+\\.\\d+)(\\s|$)`).exec(run ?? "")?.[1]
    // The lockfile's `packages:` section lists one `  [']pkg@x.y.z[']:` header per resolved version.
    const resolved = [
      ...lock.matchAll(new RegExp(`^ {2}'?${pkg}@(\\d+\\.\\d+\\.\\d+)'?:$`, "gm")),
    ].map((m) => m[1])
    expect(pinned, `${pkg} is not pinned to an exact version in the RUN line`).toBeDefined()
    expect(new Set(resolved)).toEqual(new Set([pinned]))
  }
})
