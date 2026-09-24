import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

// Text scan: the Dockerfile must declare no ARG, ENV or LABEL naming any RESEARCH_FEED credential
// -- every credential is runtime-only (decision 2/8), supplied at `docker run`/compose via
// env_file, never baked into an image layer.

const dockerfilePath = fileURLToPath(new URL("../Dockerfile", import.meta.url))

test("Dockerfile declares no ARG, ENV or LABEL naming a RESEARCH_FEED credential", () => {
  const text = readFileSync(dockerfilePath, "utf8")
  const declLines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*(ARG|ENV|LABEL)\b/i.test(line))
  for (const line of declLines) {
    expect(line).not.toMatch(/RESEARCH_FEED/)
  }
})

test("Dockerfile declares no ARG, ENV or LABEL at all naming a credential-shaped key", () => {
  const text = readFileSync(dockerfilePath, "utf8")
  expect(text).not.toMatch(/\b(ARG|ENV|LABEL)\s+RESEARCH_FEED_(URL|TOKEN|ACCESS_CLIENT_ID|ACCESS_CLIENT_SECRET|POLL_SECONDS|DB)\b/)
})
