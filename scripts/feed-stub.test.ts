import { type ChildProcess, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const STUB = fileURLToPath(new URL("./feed-stub.mjs", import.meta.url))

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

/** Starts the stub through its real CLI entry (the code path the flag lives on) and resolves its port. */
function startCli(extraArgs: string[]): Promise<number> {
  const env = { ...process.env }
  // A leaked env var would mask a flag that is never read.
  delete env.FEED_STUB_REQUIRE_ACCESS
  const child = spawn(process.execPath, [STUB, "--token", "t", ...extraArgs], { env })
  children.push(child)
  return new Promise((resolve, reject) => {
    let out = ""
    child.stdout?.on("data", (chunk) => {
      out += String(chunk)
      const match = /listening on 0\.0\.0\.0:(\d+)/.exec(out)
      if (match) resolve(Number(match[1]))
    })
    child.once("error", reject)
    child.once("exit", (code) => reject(new Error(`feed-stub exited early (${code})`)))
  })
}

function status(port: number, headers: Record<string, string>): Promise<number> {
  return fetch(`http://127.0.0.1:${port}/api/feed/gradings`, { headers }).then((r) => r.status)
}

const bearer = { authorization: "Bearer t" }
const access = { "cf-access-client-id": "stub-cf-id", "cf-access-client-secret": "stub-cf-secret" }

describe("feed-stub CLI --require-access", () => {
  it("rejects a request without the Access headers when the flag is set", async () => {
    const port = await startCli(["--require-access"])
    expect(await status(port, bearer)).toBe(401)
    expect(await status(port, { ...bearer, ...access })).toBe(200)
  })

  it("accepts a bearer-only request when the flag is absent", async () => {
    const port = await startCli([])
    expect(await status(port, bearer)).toBe(200)
  })
})
