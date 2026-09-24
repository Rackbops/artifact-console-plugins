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

test("extractSpecifiers finds from-clause, bare, dynamic, and require() imports", () => {
  const text = [
    'import { x } from "./x.js"',
    'export { y } from "node:fs"',
    'import "./side-effect.js"',
    'const m = await import("react")',
    'const z = require("left-pad")',
  ].join("\n")
  expect(extractSpecifiers(text)).toEqual([
    "./x.js",
    "node:fs",
    "./side-effect.js",
    "react",
    "left-pad",
  ])
})

test("extractSpecifiers finds a from-clause import wrapped across multiple lines", () => {
  const text = 'import {\n  a,\n  b,\n} from "left-pad"\n'
  expect(extractSpecifiers(text)).toEqual(["left-pad"])
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

test("fails when a HELPER file (transitively relative-imported) imports a bare package", () => {
  // Regression: the check used to only scan the entry file, so a bare import smuggled through a
  // relative-imported helper module slipped through undetected.
  const root = fixtureRoot()
  const pluginDir = writePlugin(root, "widget", {
    server: 'import { helper } from "./helper.js"\n',
  })
  writeFileSync(join(pluginDir, "dist/helper.js"), 'import leftPad from "left-pad"\nexport {}\n')
  const { ok, errors } = checkBundles(root)
  expect(ok).toBe(false)
  expect(errors.some((e) => e.includes('imports "left-pad"'))).toBe(true)
})

test("fails when a relative import escapes to a sibling dir sharing dist/'s name as a prefix", () => {
  // Regression: `resolved.startsWith(distRoot)` (a bare string-prefix compare, no trailing
  // separator) let "../dist-secret/evil.js" through, since resolving it from
  // ".../widget/dist/server.js" lands on ".../widget/dist-secret/evil.js" -- a string that starts
  // with the string ".../widget/dist" even though it is NOT under dist/ at all.
  //
  // The escaped file must exist at exactly the path the specifier actually resolves to
  // (pluginDir/dist-secret/evil.js, one level BELOW pluginDir, a sibling of dist/ itself -- not
  // pluginDir's own parent) -- otherwise the check fails via the unrelated "file does not exist"
  // branch instead of the boundary check this test exists to guard, and would pass just as well
  // against the pre-fix bare-prefix compare (verified: reverting isUnder() to
  // `resolved.startsWith(distRoot)` here left this exact scenario correctly rejected too, since with
  // the file missing entirely BOTH branches already fail it -- the assertion never distinguishes
  // the fix from its absence unless the file genuinely exists at the escaped location).
  const root = fixtureRoot()
  const pluginDir = writePlugin(root, "widget", {
    server: 'import { evil } from "../dist-secret/evil.js"\n',
  })
  mkdirSync(join(pluginDir, "dist-secret"), { recursive: true })
  writeFileSync(join(pluginDir, "dist-secret/evil.js"), "export const evil = 1\n")
  const { ok, errors } = checkBundles(root)
  expect(ok).toBe(false)
  expect(errors.some((e) => e.includes("does not resolve to a"))).toBe(true)
})

test("passes a transitive chain of relative-imported helpers that all resolve under dist/", () => {
  const root = fixtureRoot()
  const pluginDir = writePlugin(root, "widget", {
    server: 'import { a } from "./a.js"\n',
  })
  writeFileSync(join(pluginDir, "dist/a.js"), 'import { b } from "./b.js"\nexport const a = b\n')
  writeFileSync(join(pluginDir, "dist/b.js"), "export const b = 1\n")
  const { ok, errors } = checkBundles(root)
  expect(errors).toEqual([])
  expect(ok).toBe(true)
})

test("a cyclic pair of relative-imported helpers terminates instead of looping forever", () => {
  const root = fixtureRoot()
  const pluginDir = writePlugin(root, "widget", {
    server: 'import { a } from "./a.js"\n',
  })
  writeFileSync(join(pluginDir, "dist/a.js"), 'import { b } from "./b.js"\nexport const a = 1\n')
  writeFileSync(join(pluginDir, "dist/b.js"), 'import { a } from "./a.js"\nexport const b = 1\n')
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
