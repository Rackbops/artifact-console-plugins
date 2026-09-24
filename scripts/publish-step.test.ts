import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"

// Runs publish.yml's real `run:` step bodies with bash against stub pnpm/npm/gh binaries -- the
// artifact-console release-publish.test.ts pattern (its own header names this precedent).
const root = fileURLToPath(new URL("..", import.meta.url))
const workflowPath = join(root, ".github/workflows/publish.yml")

const posix = (p: string): string => p.replaceAll("\\", "/")

// A WSL bash on Windows cannot see `R:/...`; every CI runner and a Git Bash checkout can.
const hasBash = spawnSync("bash", ["-c", 'test -r "$1"', "probe", posix(workflowPath)]).status === 0

const SPAWN_TIMEOUT_MS = 15_000

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Every step's own lines, in file order (there's exactly one job, `publish`, in this workflow). */
function stepBlocks(): string[] {
  const text = readFileSync(workflowPath, "utf8")
  const lines = text.split(/\r?\n/)
  const stepsStart = lines.findIndex((l) => /^\s{4}steps:\s*$/.test(l))
  const stepLines = lines.slice(stepsStart + 1)
  const starts: number[] = []
  stepLines.forEach((l, i) => {
    if (/^\s{6}- (uses|name):/.test(l)) starts.push(i)
  })
  return starts.map((s, i) => stepLines.slice(s, starts[i + 1] ?? stepLines.length).join("\n"))
}

/** The dedented `run: |` body of the step whose name starts with `stepPrefix`. */
function stepRunBody(stepPrefix: string): string {
  const block = stepBlocks().find((b) => b.includes(`- name: ${stepPrefix}`))
  if (block === undefined) throw new Error(`step "${stepPrefix}" not found in publish.yml`)
  const lines = block.split("\n")
  const runIdx = lines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l))
  if (runIdx === -1) throw new Error(`step "${stepPrefix}" has no run: | block`)
  const indent = " ".repeat(10)
  const body: string[] = []
  for (const line of lines.slice(runIdx + 1)) {
    if (line.trim() !== "" && !line.startsWith(indent)) break
    body.push(line.slice(indent.length))
  }
  return body.join("\n")
}

function fixtureRepo(opts: { version?: string; changelog?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "publish-step-"))
  dirs.push(dir)
  const pluginDir = join(dir, "plugins/hello-remote")
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify(
      { name: "@rackbops/ac-plugin-hello-remote", version: opts.version ?? "0.1.0" },
      null,
      2,
    ),
  )
  writeFileSync(
    join(pluginDir, "CHANGELOG.md"),
    opts.changelog ?? "## [0.1.0] - 2026-09-24\n\nFirst release.\n",
  )
  return dir
}

function run(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-e", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  })
}

test.skipIf(!hasBash)(
  "resolves name=hello-remote, version=0.1.0 from the tag hello-remote-v0.1.0",
  () => {
    const dir = fixtureRepo()
    const script = `${stepRunBody("Resolve the plugin name and version from the tag")}\necho "name=$name version=$version"`
    const result = run(script, dir, { TAG: "hello-remote-v0.1.0", GITHUB_OUTPUT: "/dev/null" })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("name=hello-remote version=0.1.0")
  },
)

test.skipIf(!hasBash)("resolving a nonexistent plugin's tag fails", () => {
  const dir = fixtureRepo()
  const script = stepRunBody("Resolve the plugin name and version from the tag")
  const result = run(script, dir, { TAG: "nonexistent-v0.1.0", GITHUB_OUTPUT: "/dev/null" })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/no such plugin/)
})

test.skipIf(!hasBash)("a package.json version mismatch fails", () => {
  const dir = fixtureRepo({ version: "0.2.0" })
  const script = stepRunBody("Require the package.json version to equal the tag's version")
  const result = run(script, dir, { NAME: "hello-remote", VERSION: "0.1.0" })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/!= plugins\/hello-remote\/package\.json version 0\.2\.0/)
})

test.skipIf(!hasBash)("a matching package.json version passes", () => {
  const dir = fixtureRepo({ version: "0.1.0" })
  const script = stepRunBody("Require the package.json version to equal the tag's version")
  const result = run(script, dir, { NAME: "hello-remote", VERSION: "0.1.0" })
  expect(result.status, result.stderr).toBe(0)
})

test.skipIf(!hasBash)("a missing CHANGELOG section fails", () => {
  const dir = fixtureRepo({ changelog: "## [0.0.9] - 2026-01-01\n\nOld.\n" })
  const script = stepRunBody("Require a CHANGELOG section for this version")
  const result = run(script, dir, { NAME: "hello-remote", VERSION: "0.1.0" })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/has no section for version 0\.1\.0/)
})

test.skipIf(!hasBash)("a present CHANGELOG section passes", () => {
  const dir = fixtureRepo({ changelog: "## [0.1.0] - 2026-09-24\n\nFirst release.\n" })
  const script = stepRunBody("Require a CHANGELOG section for this version")
  const result = run(script, dir, { NAME: "hello-remote", VERSION: "0.1.0" })
  expect(result.status, result.stderr).toBe(0)
})

// ---- the "Publish to npm" step: a stub pnpm records its argv ------------------------------------

const STUB_PNPM = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo 11.2.0; exit 0; fi
echo "$*" >> "$STUB_DIR/args"
`

function runPublishStep(env: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(join(tmpdir(), "publish-step-npm-"))
  dirs.push(dir)
  writeFileSync(join(dir, "pnpm"), STUB_PNPM, { mode: 0o755 })
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH"
  const result = spawnSync("bash", ["-e", "-c", stepRunBody("Publish to npm")], {
    cwd: dir,
    env: {
      ...process.env,
      [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ""}`,
      STUB_DIR: posix(dir),
      HOME: posix(dir),
      NPM_CONFIG_USERCONFIG: posix(join(dir, "npmrc")),
      RUNNER_TEMP: posix(dir),
      NODE_AUTH_TOKEN: "",
      NAME: "hello-remote",
      VERSION: "0.1.0",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/idtoken",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "stub",
      ...env,
    },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  })
  const args = (() => {
    try {
      return readFileSync(join(dir, "args"), "utf8").trim()
    } catch {
      return ""
    }
  })()
  return { result, args }
}

test.skipIf(!hasBash)("a public repo publishes via OIDC with --provenance", () => {
  const { result, args } = runPublishStep({ REPO_PRIVATE: "false" })
  expect(result.status, result.stderr).toBe(0)
  expect(args).toMatch(/--filter @rackbops\/ac-plugin-hello-remote publish .*--provenance/)
})

test.skipIf(!hasBash)("a private repo publishes via OIDC without --provenance", () => {
  const { result, args } = runPublishStep({ REPO_PRIVATE: "true" })
  expect(result.status, result.stderr).toBe(0)
  expect(args).not.toMatch(/--provenance/)
})

test.skipIf(!hasBash)("a stable version publishes with --tag latest", () => {
  const { result, args } = runPublishStep({ REPO_PRIVATE: "false", VERSION: "0.1.0" })
  expect(result.status, result.stderr).toBe(0)
  expect(args).toMatch(/--tag latest/)
})

test.skipIf(!hasBash)("a prerelease version publishes with --tag next", () => {
  const { result, args } = runPublishStep({ REPO_PRIVATE: "false", VERSION: "0.1.0-alpha.1" })
  expect(result.status, result.stderr).toBe(0)
  expect(args).toMatch(/--tag next/)
})

test.skipIf(!hasBash)("token auth never passes --provenance, even when public", () => {
  const { result, args } = runPublishStep({ REPO_PRIVATE: "false", NODE_AUTH_TOKEN: "stub-token" })
  expect(result.status, result.stderr).toBe(0)
  expect(args).not.toMatch(/--provenance/)
})

// ---- the "Verify the published tarball..." step: a kind: "sidecar" plugin (#453) --------------

function sidecarFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "publish-step-sidecar-"))
  dirs.push(dir)
  const pluginDir = join(dir, "plugins/research-feed-store")
  mkdirSync(pluginDir, { recursive: true })
  // A real kind: "sidecar" manifest: no acPlugin.server, no acPlugin.frontend, files: [] -- `npm
  // pack --dry-run` lists only package.json + whatever npm always includes (README/LICENSE), never
  // a dist/ tree.
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: "@rackbops/ac-plugin-research-feed-store",
        version: "0.1.0",
        files: [],
        acPlugin: {
          id: "research-feed-store",
          hostApiVersion: 1,
          kind: "sidecar",
          sidecar: { image: "ghcr.io/rackbops/ac-research-feed-store", healthPath: "/healthz" },
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(join(pluginDir, "README.md"), "# research-feed-store\n")
  return dir
}

test.skipIf(!hasBash)(
  "the tarball-verify step passes a sidecar plugin with no dist/server.js or dist/ui.js at all",
  () => {
    const dir = sidecarFixtureRepo()
    const script = stepRunBody(
      "Verify the published tarball will carry the declared server/frontend entries",
    )
    const result = run(script, dir, { NAME: "research-feed-store" })
    expect(result.status, result.stderr).toBe(0)
  },
)

test.skipIf(!hasBash)(
  "the tarball-verify step still fails an in-process plugin missing dist/server.js",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "publish-step-inprocess-"))
    dirs.push(dir)
    const pluginDir = join(dir, "plugins/hello-remote")
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@rackbops/ac-plugin-hello-remote",
          version: "0.1.0",
          files: ["dist"],
          acPlugin: {
            id: "hello-remote",
            hostApiVersion: 1,
            kind: "in-process",
            server: "dist/server.js",
          },
        },
        null,
        2,
      ),
    )
    // Deliberately no dist/ directory at all -- the declared entry can never ship.
    const script = stepRunBody(
      "Verify the published tarball will carry the declared server/frontend entries",
    )
    const result = run(script, dir, { NAME: "hello-remote" })
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toMatch(/does not list dist\/server\.js/)
  },
)
