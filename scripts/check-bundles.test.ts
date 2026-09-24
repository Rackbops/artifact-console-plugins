import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { checkBundles, extractSpecifiers } from "./check-bundles.mjs"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-bundles-"))
  dirs.push(dir)
  return dir
}

function writePlugin(
  root: string,
  id: string,
  files: { server?: string; frontend?: string; extra?: Record<string, string> },
) {
  const pluginDir = join(root, "plugins", id)
  mkdirSync(join(pluginDir, "dist"), { recursive: true })
  const acPlugin: Record<string, unknown> = { id, hostApiVersion: 1, kind: "in-process" }
  if (files.server !== undefined) {
    acPlugin.server = "dist/server.js"
    writeFileSync(join(pluginDir, "dist/server.js"), files.server)
  }
  if (files.frontend !== undefined) {
    acPlugin.frontend = "dist/ui.js"
    writeFileSync(join(pluginDir, "dist/ui.js"), files.frontend)
  }
  for (const [rel, content] of Object.entries(files.extra ?? {})) {
    mkdirSync(join(pluginDir, "dist"), { recursive: true })
    writeFileSync(join(pluginDir, rel), content)
  }
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ acPlugin }, null, 2))
  return pluginDir
}

test("extractSpecifiers finds from-clause, bare, and dynamic imports", () => {
  const text = [
    'import { x } from "./x.js"',
    'export { y } from "node:fs"',
    'import "./side-effect.js"',
    'const m = await import("react")',
  ].join("\n")
  expect(extractSpecifiers(text)).toEqual(["./x.js", "node:fs", "./side-effect.js", "react"])
})

test("fails when server.js imports a bare package", () => {
  const root = fixtureRoot()
  writePlugin(root, "widget", { server: 'import { z } from "left-pad"\n' })
  const { ok, errors } = checkBundles(root)
  expect(ok).toBe(false)
  expect(errors.some((e) => e.includes('imports "left-pad"'))).toBe(true)
})

test("fails when ui.js imports a non-import-map specifier", () => {
  const root = fixtureRoot()
  writePlugin(root, "widget", { frontend: 'import { z } from "lodash"\n' })
  const { ok, errors } = checkBundles(root)
  expect(ok).toBe(false)
  expect(errors.some((e) => e.includes('imports "lodash"'))).toBe(true)
})

test("fails when a relative import doesn't resolve under dist/", () => {
  const root = fixtureRoot()
  writePlugin(root, "widget", { server: 'import { z } from "./missing.js"\n' })
  const { ok, errors } = checkBundles(root)
  expect(ok).toBe(false)
  expect(errors.some((e) => e.includes("does not resolve to a"))).toBe(true)
})

test("passes a server bundle using only node: builtins and resolving relative imports", () => {
  const root = fixtureRoot()
  const pluginDir = writePlugin(root, "widget", {
    server: 'import { readFile } from "node:fs"\nimport { helper } from "./helper.js"\n',
  })
  writeFileSync(join(pluginDir, "dist/helper.js"), "export const helper = 1\n")
  const { ok, errors } = checkBundles(root)
  expect(errors).toEqual([])
  expect(ok).toBe(true)
})

test("passes a frontend bundle using only import-map specifiers", () => {
  const root = fixtureRoot()
  writePlugin(root, "widget", {
    frontend: 'import { useEffect } from "react"\nimport { fetch } from "@ac/host"\n',
  })
  const { ok, errors } = checkBundles(root)
  expect(errors).toEqual([])
  expect(ok).toBe(true)
})

// ---- the real repo: hello-remote's actual built dist -----------------------------------------

test("passes for the real built hello-remote", () => {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const { ok, errors } = checkBundles(root)
  expect(errors).toEqual([])
  expect(ok).toBe(true)
})
