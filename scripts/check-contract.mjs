import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv from "ajv"

// checkContract(root): three checks that keep every plugin's manifest honest against the published
// @rackbops/ac-plugin-contract ABI.
//
// (a) the vendored schema (vendor/ac-plugin-contract/schema.json, committed so a check can run with
//     no network access) must be byte-identical to the installed package's own copy;
// (b) every plugins/*/package.json `acPlugin` block validates against that schema;
// (c) each `acPlugin.hostApiVersion` equals the installed package's exported HOST_API_VERSION.
//
// Each returns a plain result object rather than throwing, so the CLI guard below can report every
// failure in one run instead of stopping at the first.

const VENDORED_SCHEMA = "vendor/ac-plugin-contract/schema.json"
const INSTALLED_SCHEMA = "node_modules/@rackbops/ac-plugin-contract/schema.json"

/**
 * @param {string} root
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkContract(root) {
  const errors = []

  const vendoredPath = join(root, VENDORED_SCHEMA)
  const installedPath = join(root, INSTALLED_SCHEMA)
  if (!existsSync(installedPath)) {
    errors.push(`${INSTALLED_SCHEMA} does not exist -- run pnpm install`)
    return { ok: false, errors }
  }
  const installedText = readFileSync(installedPath, "utf8")
  if (!existsSync(vendoredPath)) {
    errors.push(`${VENDORED_SCHEMA} does not exist -- copy it from ${INSTALLED_SCHEMA}`)
  } else {
    const vendoredText = readFileSync(vendoredPath, "utf8")
    if (vendoredText !== installedText) {
      errors.push(
        `${VENDORED_SCHEMA} has drifted from ${INSTALLED_SCHEMA} -- re-vendor: ` +
          `cp ${INSTALLED_SCHEMA} ${VENDORED_SCHEMA}`,
      )
    }
  }

  const schema = JSON.parse(installedText)
  const ajv = new Ajv({ strict: false })
  const validate = ajv.compile(schema)

  const hostApiVersion = readHostApiVersion(root)
  if (hostApiVersion === undefined) {
    errors.push(
      "could not read HOST_API_VERSION from " +
        "node_modules/@rackbops/ac-plugin-contract/dist/version.js -- refusing to silently skip " +
        "every plugin's hostApiVersion check",
    )
  }

  const pluginsDir = join(root, "plugins")
  const dirs = existsSync(pluginsDir) ? readdirSync(pluginsDir, { withFileTypes: true }) : []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const pkgPath = join(pluginsDir, dir.name, "package.json")
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    const manifest = pkg.acPlugin
    if (manifest === undefined || manifest === null || typeof manifest !== "object") continue

    if (!validate(manifest)) {
      const messages = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`)
      errors.push(
        `plugins/${dir.name}/package.json: acPlugin manifest is invalid: ${messages.join("; ")}`,
      )
    }

    if (hostApiVersion !== undefined && manifest.hostApiVersion !== hostApiVersion) {
      errors.push(
        `plugins/${dir.name}/package.json: acPlugin.hostApiVersion is ${manifest.hostApiVersion}, ` +
          `expected ${hostApiVersion} (the installed @rackbops/ac-plugin-contract's HOST_API_VERSION)`,
      )
    }
  }

  return { ok: errors.length === 0, errors }
}

function readHostApiVersion(root) {
  try {
    const versionPath = join(root, "node_modules/@rackbops/ac-plugin-contract/dist/version.js")
    const text = readFileSync(versionPath, "utf8")
    const m = /HOST_API_VERSION\s*=\s*(\d+)/.exec(text)
    return m ? Number(m[1]) : undefined
  } catch {
    return undefined
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const { ok, errors } = checkContract(root)
  if (!ok) {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
  process.stdout.write("+ check-contract passed\n")
}
