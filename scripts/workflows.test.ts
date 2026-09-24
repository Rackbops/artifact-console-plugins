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
