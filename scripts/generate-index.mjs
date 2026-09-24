import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Generates this workspace's plugin index (plugins.json) from each plugins/<dir>/package.json's
// `acPlugin` block + that plugin's CHANGELOG.md — a port of artifact-console's own
// scripts/generate-index.mjs, adapted for a repo that PUBLISHES its plugins rather than bundling
// them into an image. The committed plugins.json is a drift guard, checked by `--check` below,
// and IS the served index (raw.githubusercontent.com), unlike the host repo's own copy, which
// exists only to keep the bundled image's plugin list in sync — so `generatedAt` stays omitted
// here for the same byte-stability reason the host's own file omits it (sorted by codepoint, not
// localeCompare, so Windows and Linux produce identical output).
//
// Three refusals beyond the host repo's own shape, load-bearing for a PUBLISHED package: the
// directory name must equal `acPlugin.id` (release tags are `<id>-v<semver>`), the `package.json`
// `name` must equal `@rackbops/ac-plugin-<id>`, and `repository.url`/`repository.directory` must
// name this repo and the plugin's own directory (a provenance publish checks the repository).

const SCHEMA_VERSION = 1
const HOST = "artifact-console"
const REPO_URL = "git+https://github.com/Rackbops/artifact-console-plugins.git"

/**
 * Parse a Keep-a-Changelog file into releases: each `## <version> - <YYYY-MM-DD>` heading + its body.
 * @param {string} text
 * @returns {{ version: string, date: string, notes?: string }[]}
 */
export function parseChangelog(text) {
  const heading = /^##\s+\[?([0-9][^\]\s]*)\]?\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/
  const releases = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    const m = heading.exec(line)
    if (m) {
      if (current) releases.push(finalizeRelease(current))
      current = { version: m[1], date: m[2], notes: [] }
    } else if (current) {
      current.notes.push(line)
    }
  }
  if (current) releases.push(finalizeRelease(current))
  return releases
}

function finalizeRelease(c) {
  const notes = c.notes.join("\n").trim()
  return notes ? { version: c.version, date: c.date, notes } : { version: c.version, date: c.date }
}

/**
 * Build the plugin index by scanning `pluginsDir` (each subdir's package.json `acPlugin` + CHANGELOG.md).
 * @param {string} pluginsDir
 * @returns {{ schemaVersion: number, plugins: object[] }}
 */
export function generateIndex(pluginsDir) {
  const plugins = []
  const seen = new Set()
  const dirs = existsSync(pluginsDir) ? readdirSync(pluginsDir, { withFileTypes: true }) : []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const pkgPath = join(pluginsDir, dir.name, "package.json")
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    const manifest = pkg.acPlugin
    if (manifest === undefined || manifest === null || typeof manifest !== "object") continue
    const name = manifest.id
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`plugin at ${pkgPath} has an acPlugin block with no valid string id`)
    }
    if (name !== dir.name) {
      throw new Error(
        `plugin at ${pkgPath} has acPlugin.id "${name}" but lives in directory "${dir.name}" — ` +
          "the directory name must equal the plugin id (release tags are <id>-v<semver>)",
      )
    }
    const expectedPackage = `@rackbops/ac-plugin-${name}`
    if (pkg.name !== expectedPackage) {
      throw new Error(
        `plugin "${name}" has package name "${pkg.name}", expected "${expectedPackage}"`,
      )
    }
    assertRepository(pkgPath, name, pkg.repository)
    if (seen.has(name)) {
      throw new Error(`duplicate plugin id "${name}" across plugins/ — plugin ids must be unique`)
    }
    seen.add(name)
    plugins.push({
      host: HOST,
      name,
      package: pkg.name,
      version: pkg.version,
      hostApiVersion: manifest.hostApiVersion,
      env: manifest.env ?? [],
      releases: releasesFor(join(pluginsDir, dir.name), pkg),
    })
  }
  // Sort by codepoint (not localeCompare) so the committed artifact is byte-stable across machines
  // and locales — the Windows dev box and the Linux CI runner must produce an identical plugins.json.
  plugins.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { schemaVersion: SCHEMA_VERSION, plugins }
}

function assertRepository(pkgPath, name, repository) {
  const expectedDirectory = `plugins/${name}`
  if (
    repository === undefined ||
    repository === null ||
    typeof repository !== "object" ||
    repository.url !== REPO_URL ||
    repository.directory !== expectedDirectory
  ) {
    throw new Error(
      `plugin "${name}" (${pkgPath}) must declare repository.url "${REPO_URL}" and ` +
        `repository.directory "${expectedDirectory}" — a provenance publish checks the repository`,
    )
  }
}

function releasesFor(pluginDir, pkg) {
  const changelog = join(pluginDir, "CHANGELOG.md")
  const releases = existsSync(changelog) ? parseChangelog(readFileSync(changelog, "utf8")) : []
  if (!releases.some((r) => r.version === pkg.version)) {
    throw new Error(
      `plugin "${pkg.name}" version ${pkg.version} has no matching section in ${changelog} — ` +
        "every published version needs a CHANGELOG entry",
    )
  }
  return releases
}

function serialize(index) {
  return `${JSON.stringify(index, null, 2)}\n`
}

// CLI:
//   node scripts/generate-index.mjs          -> writes the committed plugins.json
//   node scripts/generate-index.mjs --check  -> fails (exit 1) if plugins.json would change
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pluginsDir = fileURLToPath(new URL("../plugins", import.meta.url))
  const out = fileURLToPath(new URL("../plugins.json", import.meta.url))
  const check = process.argv.includes("--check")
  try {
    const text = serialize(generateIndex(pluginsDir))
    if (check) {
      const committed = existsSync(out) ? readFileSync(out, "utf8") : ""
      if (committed !== text) {
        console.error("plugins.json is stale -- run pnpm run generate-index")
        process.exit(1)
      }
      process.stdout.write("+ plugins.json is up to date\n")
    } else {
      writeFileSync(out, text)
      process.stdout.write(`+ wrote ${out}\n`)
    }
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
