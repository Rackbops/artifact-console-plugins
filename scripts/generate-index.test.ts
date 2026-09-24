import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { generateIndex, parseChangelog } from "./generate-index.mjs"

const REPO_URL = "git+https://github.com/Rackbops/artifact-console-plugins.git"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixturePluginsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "generate-index-"))
  dirs.push(dir)
  return dir
}

function writePlugin(
  pluginsDir: string,
  dirName: string,
  overrides: {
    id?: string
    packageName?: string
    version?: string
    repository?: unknown
    changelog?: string
  } = {},
) {
  const id = overrides.id ?? dirName
  const version = overrides.version ?? "0.1.0"
  const pluginDir = join(pluginsDir, dirName)
  mkdirSync(pluginDir, { recursive: true })
  const pkg = {
    name: overrides.packageName ?? `@rackbops/ac-plugin-${id}`,
    version,
    repository:
      overrides.repository === undefined
        ? { type: "git", url: REPO_URL, directory: `plugins/${dirName}` }
        : overrides.repository,
    acPlugin: { id, hostApiVersion: 1, kind: "in-process", server: "dist/server.js" },
  }
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify(pkg, null, 2))
  const changelog =
    overrides.changelog ?? `# Changelog\n\n## [${version}] - 2026-09-24\n\nFirst release.\n`
  writeFileSync(join(pluginDir, "CHANGELOG.md"), changelog)
  return pluginDir
}

test("builds the envelope for a fixture plugin dir", () => {
  const pluginsDir = fixturePluginsDir()
  writePlugin(pluginsDir, "widget")
  const index = generateIndex(pluginsDir)
  expect(index).toEqual({
    schemaVersion: 1,
    plugins: [
      {
        host: "artifact-console",
        name: "widget",
        package: "@rackbops/ac-plugin-widget",
        version: "0.1.0",
        hostApiVersion: 1,
        env: [],
        releases: [{ version: "0.1.0", date: "2026-09-24", notes: "First release." }],
      },
    ],
  })
})

test("refuses a directory name that differs from acPlugin.id", () => {
  const pluginsDir = fixturePluginsDir()
  writePlugin(pluginsDir, "widget", { id: "not-widget" })
  expect(() => generateIndex(pluginsDir)).toThrow(/directory name must equal the plugin id/)
})

test("refuses a package name that isn't @rackbops/ac-plugin-<id>", () => {
  const pluginsDir = fixturePluginsDir()
  writePlugin(pluginsDir, "widget", { packageName: "widget" })
  expect(() => generateIndex(pluginsDir)).toThrow(/expected "@rackbops\/ac-plugin-widget"/)
})

test("refuses a wrong repository.url", () => {
  const pluginsDir = fixturePluginsDir()
  writePlugin(pluginsDir, "widget", {
    repository: {
      type: "git",
      url: "git+https://github.com/someone/else.git",
      directory: "plugins/widget",
    },
  })
  expect(() => generateIndex(pluginsDir)).toThrow(/must declare repository\.url/)
})

test("refuses a wrong repository.directory", () => {
  const pluginsDir = fixturePluginsDir()
  writePlugin(pluginsDir, "widget", {
    repository: { type: "git", url: REPO_URL, directory: "plugins/not-widget" },
  })
  expect(() => generateIndex(pluginsDir)).toThrow(/must declare repository\.url/)
})

test("refuses a version with no CHANGELOG section", () => {
  const pluginsDir = fixturePluginsDir()
  writePlugin(pluginsDir, "widget", {
    changelog: "# Changelog\n\n## [0.0.9] - 2026-01-01\n\nOld.\n",
  })
  expect(() => generateIndex(pluginsDir)).toThrow(/has no matching section/)
})

test("parseChangelog reads bracketed and unbracketed headings", () => {
  const text = "## [1.0.0] - 2026-01-01\n\nNotes one.\n\n## 1.1.0 - 2026-02-01\n\nNotes two.\n"
  expect(parseChangelog(text)).toEqual([
    { version: "1.0.0", date: "2026-01-01", notes: "Notes one." },
    { version: "1.1.0", date: "2026-02-01", notes: "Notes two." },
  ])
})

// ---- the real repo: the committed plugins.json and the --check CLI mode -------------------------

const root = fileURLToPath(new URL("..", import.meta.url))
const scriptPath = join(root, "scripts/generate-index.mjs")
const plugintsJsonPath = join(root, "plugins.json")

function runCheck() {
  return spawnSync(process.execPath, [scriptPath, "--check"], { cwd: root, encoding: "utf8" })
}

test("the committed plugins.json equals a fresh generate (drift guard)", () => {
  const fresh = `${JSON.stringify(generateIndex(join(root, "plugins")), null, 2)}\n`
  expect(readFileSync(plugintsJsonPath, "utf8")).toBe(fresh)
})

test("--check passes on a fresh generate", () => {
  const result = runCheck()
  expect(result.status).toBe(0)
})

test("--check fails naming plugins.json when the committed file is hand-edited", () => {
  const original = readFileSync(plugintsJsonPath, "utf8")
  try {
    writeFileSync(plugintsJsonPath, original.replace('"0.1.0"', '"9.9.9"'))
    const result = runCheck()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/plugins\.json is stale -- run pnpm run generate-index/)
  } finally {
    writeFileSync(plugintsJsonPath, original)
  }
})
