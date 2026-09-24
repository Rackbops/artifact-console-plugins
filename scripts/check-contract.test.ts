import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { checkContract } from "./check-contract.mjs"

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url))
const REAL_SCHEMA = readFileSync(
  join(REAL_ROOT, "node_modules/@rackbops/ac-plugin-contract/schema.json"),
  "utf8",
)
const REAL_VERSION_JS = readFileSync(
  join(REAL_ROOT, "node_modules/@rackbops/ac-plugin-contract/dist/version.js"),
  "utf8",
)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fixture root with a real (unmodified) vendored + installed schema, so a caller only needs to
 *  vary one thing (a manifest, or the vendored copy) to isolate what's under test. */
function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-contract-"))
  dirs.push(dir)
  mkdirSync(join(dir, "vendor/ac-plugin-contract"), { recursive: true })
  mkdirSync(join(dir, "node_modules/@rackbops/ac-plugin-contract/dist"), { recursive: true })
  writeFileSync(join(dir, "vendor/ac-plugin-contract/schema.json"), REAL_SCHEMA)
  writeFileSync(join(dir, "node_modules/@rackbops/ac-plugin-contract/schema.json"), REAL_SCHEMA)
  writeFileSync(
    join(dir, "node_modules/@rackbops/ac-plugin-contract/dist/version.js"),
    REAL_VERSION_JS,
  )
  return dir
}

function writeManifest(root: string, id: string, manifest: unknown) {
  const pluginDir = join(root, "plugins", id)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ acPlugin: manifest }, null, 2))
}

test("passes when the vendored schema is byte-identical and manifests are valid", () => {
  const root = fixtureRoot()
  writeManifest(root, "widget", {
    id: "widget",
    hostApiVersion: 1,
    kind: "in-process",
    server: "dist/server.js",
  })
  const { ok, errors } = checkContract(root)
  expect(errors).toEqual([])
  expect(ok).toBe(true)
})

test("fails on a one-byte change to the vendored schema", () => {
  // Flips one character rather than appending -- same LENGTH as the real schema, so this only
  // fails a real byte-for-byte compare, never a "compare lengths instead" stand-in for one.
  const flipped = `${REAL_SCHEMA.slice(0, -2)}${REAL_SCHEMA.at(-2) === "}" ? "{" : "}"}${REAL_SCHEMA.slice(-1)}`
  expect(flipped.length).toBe(REAL_SCHEMA.length)
  expect(flipped).not.toBe(REAL_SCHEMA)
  const root = fixtureRoot()
  writeFileSync(join(root, "vendor/ac-plugin-contract/schema.json"), flipped)
  const { ok, errors } = checkContract(root)
  expect(ok).toBe(false)
  expect(errors.some((e) => e.includes("has drifted from"))).toBe(true)
})

test("fails on a manifest the schema rejects", () => {
  const root = fixtureRoot()
  writeManifest(root, "widget", { id: "widget", hostApiVersion: 1, kind: "nope" })
  const { ok, errors } = checkContract(root)
  expect(ok).toBe(false)
  expect(errors.some((e) => e.includes("widget/package.json"))).toBe(true)
})

test("fails when hostApiVersion differs from HOST_API_VERSION", () => {
  const root = fixtureRoot()
  writeManifest(root, "widget", {
    id: "widget",
    hostApiVersion: 99,
    kind: "in-process",
    server: "dist/server.js",
  })
  const { ok, errors } = checkContract(root)
  expect(ok).toBe(false)
  expect(errors.some((e) => e.includes("hostApiVersion is 99"))).toBe(true)
})

// ---- the real repo -------------------------------------------------------------------------------

test("check-contract passes against the real repo", () => {
  const { ok, errors } = checkContract(REAL_ROOT)
  expect(errors).toEqual([])
  expect(ok).toBe(true)
})
