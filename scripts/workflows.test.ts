import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

// Pins the runner rule this repo exists to prove out: it's public, so every job runs on
// GitHub-hosted ubuntu-latest and no workflow may name self-hosted (the org's runner group
// refuses public repos anyway; roshne's standing rule is a public repo never touches one).

const workflowsDir = fileURLToPath(new URL("../.github/workflows", import.meta.url))
const workflowFiles = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml"))

function read(file: string): string {
  return readFileSync(join(workflowsDir, file), "utf8")
}

/** `read(file)` with every full-line `#` comment stripped, so a comment merely explaining a rule
 *  (e.g. "never self-hosted") can't be mistaken for the workflow actually doing the thing. */
function code(file: string): string {
  return read(file)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
}

test("every workflow file exists and is non-empty", () => {
  expect(workflowFiles.length).toBeGreaterThan(0)
})

for (const file of workflowFiles) {
  test(`${file}: no job names self-hosted`, () => {
    expect(code(file)).not.toMatch(/self-hosted/)
  })

  test(`${file}: no secrets: inherit`, () => {
    expect(code(file)).not.toMatch(/secrets:\s*inherit/)
  })
}

test("ci.yml's job grants only read-only contents permission (least privilege on a public repo)", () => {
  expect(code("ci.yml")).toMatch(/permissions:\s*\n\s*contents:\s*read/)
})

for (const file of ["ci.yml", "publish.yml"]) {
  test(`${file}: every job's runs-on is ubuntu-latest`, () => {
    const text = read(file)
    const runsOnLines = text.match(/runs-on:.*/g) ?? []
    expect(runsOnLines.length).toBeGreaterThan(0)
    for (const line of runsOnLines) expect(line).toMatch(/runs-on:\s*ubuntu-latest\s*$/)
  })
}

test("publish.yml scopes id-token: write to the job, not the workflow", () => {
  const text = read("publish.yml")
  expect(text).not.toMatch(/^permissions:/m) // no top-level (workflow-wide) permissions block
  expect(text).toMatch(/permissions:\s*\n\s*contents:\s*write\s*\n\s*id-token:\s*write/)
})

test("publish.yml sets no registry-url on setup-node", () => {
  expect(code("publish.yml")).not.toMatch(/registry-url/)
})

test("publish.yml has the fork guard pointed at this repo", () => {
  expect(read("publish.yml")).toMatch(
    /if:\s*github\.repository == 'Rackbops\/artifact-console-plugins'/,
  )
})

test("publish.yml reads the tag through env, never inline github.ref_name in a run: body", () => {
  const text = read("publish.yml")
  // Every `run:` block that uses the tag reads it from an `env: TAG:`/`NAME:`/`VERSION:` mapping
  // resolved above the script, never interpolates github.ref_name directly inside the shell body.
  const runBlocks = text.split(/\n(?=\s*- name:)/)
  for (const block of runBlocks) {
    if (!block.includes("run: |")) continue
    const [, body = ""] = block.split(/run:\s*\|/)
    expect(body).not.toMatch(/\$\{\{\s*github\.ref_name\s*\}\}/)
  }
  expect(text).toMatch(/TAG:\s*\$\{\{\s*github\.ref_name\s*\}\}/)
})

test("push-notify.yml passes runner ubuntu-latest and the secret explicitly", () => {
  const text = read("push-notify.yml")
  expect(text).toMatch(/runner:\s*'\["ubuntu-latest"\]'/)
  expect(text).toMatch(/DISCORD_PUSH_WEBHOOK:\s*\$\{\{\s*secrets\.DISCORD_PUSH_WEBHOOK\s*\}\}/)
})

test("ci.yml has no fork guard (it holds no secrets)", () => {
  expect(read("ci.yml")).not.toMatch(/github\.repository ==/)
})

// research-feed-store (#453): the sidecar-smoke job builds (never pushes) a container image and
// drives it against scripts/feed-stub.mjs; publish.yml's Dockerfile branch is the only place that
// ever pushes one, and only from a release tag.

test("ci.yml's sidecar-smoke job runs on ubuntu-latest and never pushes an image", () => {
  const text = read("ci.yml")
  expect(text).toMatch(/sidecar-smoke:\s*\n\s*runs-on:\s*ubuntu-latest/)
  // The job's own docker build step has no --push/-o type=registry, and issues no `docker push`.
  const jobStart = text.indexOf("sidecar-smoke:")
  const job = text.slice(jobStart)
  expect(job).toMatch(/docker build/)
  expect(job).not.toMatch(/docker push/)
  expect(job).not.toMatch(/--push/)
})

test("publish.yml grants packages: write only to the publish job (job-level, not workflow-level)", () => {
  const text = code("publish.yml")
  expect(text).not.toMatch(/^permissions:/m) // still no top-level (workflow-wide) permissions block
  expect(text).toMatch(
    /permissions:\s*\n\s*contents:\s*write\s*\n\s*id-token:\s*write\s*\n\s*packages:\s*write/,
  )
})

test("publish.yml's image push runs only when the plugin has a Dockerfile", () => {
  const text = read("publish.yml")
  expect(text).toMatch(/if \[ -f "plugins\/\$\{NAME\}\/Dockerfile" \]/)
  const pushStepIdx = text.indexOf("Build and push the sidecar image")
  expect(pushStepIdx).toBeGreaterThan(-1)
  const pushStep = text.slice(pushStepIdx, pushStepIdx + 400)
  expect(pushStep).toMatch(/if:\s*steps\.sidecar\.outputs\.has-dockerfile == 'true'/)
  expect(pushStep).toMatch(/platforms:\s*linux\/amd64/)
  // No :latest tag -- a deploy always pins the exact published version.
  expect(pushStep).not.toMatch(/:latest/)
})

test("publish.yml's sidecar image push authenticates with the job's own GITHUB_TOKEN, not a separate registry secret", () => {
  const text = read("publish.yml")
  const loginIdx = text.indexOf("Log in to ghcr.io")
  expect(loginIdx).toBeGreaterThan(-1)
  const loginStep = text.slice(loginIdx, loginIdx + 300)
  expect(loginStep).toMatch(/password:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/)
})
