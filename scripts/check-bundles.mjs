import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// checkBundles(root): an installed plugin ships with NO node_modules -- the host extracts only
// package/package.json and package/dist/** from a published tarball -- so a built plugin's own
// dist/ must be self-contained. For each plugins/*/package.json's `acPlugin.server` (Node builtins
// and relative imports only) and `acPlugin.frontend` (the host's seven import-map specifiers, plus
// relative imports), every static import/export...from and dynamic import("...") specifier is
// checked; a relative specifier must additionally resolve to a real file under dist/.

const FRONTEND_SPECIFIERS = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "react-router",
  "@ac/host",
  "@rackbops/ui-react",
])

// Matches `import ... from "spec"` / `export ... from "spec"` (from-clause), bare `import "spec"`,
// and dynamic `import("spec")`. Deliberately simple (three regexes, not a real parser) -- the
// bundles here are `tsc`-emitted ESM with no build-time string concatenation, so a specifier is
// always a plain string literal.
const FROM_CLAUSE_RE = /\b(?:import|export)\b[^'";\n]*\bfrom\s*(['"])((?:(?!\1).)*)\1/g
const BARE_IMPORT_RE = /^\s*import\s*(['"])((?:(?!\1).)*)\1/gm
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])((?:(?!\1).)*)\1/g

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractSpecifiers(text) {
  const specifiers = []
  for (const re of [FROM_CLAUSE_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    for (const m of text.matchAll(re)) specifiers.push(m[2])
  }
  return specifiers
}

/**
 * @param {string} specifier
 * @returns {boolean}
 */
function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

/**
 * @param {string} root
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkBundles(root) {
  const errors = []
  const pluginsDir = join(root, "plugins")
  const dirs = existsSync(pluginsDir) ? readdirSync(pluginsDir, { withFileTypes: true }) : []

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const pluginDir = join(pluginsDir, dir.name)
    const pkgPath = join(pluginDir, "package.json")
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    const manifest = pkg.acPlugin
    if (manifest === undefined || manifest === null || typeof manifest !== "object") continue

    if (typeof manifest.server === "string") {
      checkFile(pluginDir, manifest.server, "server", isServerSpecifierAllowed, errors, dir.name)
    }
    if (typeof manifest.frontend === "string") {
      checkFile(
        pluginDir,
        manifest.frontend,
        "frontend",
        isFrontendSpecifierAllowed,
        errors,
        dir.name,
      )
    }
  }

  return { ok: errors.length === 0, errors }
}

function isServerSpecifierAllowed(specifier) {
  return isRelative(specifier) || specifier.startsWith("node:")
}

function isFrontendSpecifierAllowed(specifier) {
  return isRelative(specifier) || FRONTEND_SPECIFIERS.has(specifier)
}

function checkFile(pluginDir, relFile, kind, isAllowed, errors, pluginName) {
  const filePath = join(pluginDir, relFile)
  if (!existsSync(filePath)) {
    errors.push(
      `plugins/${pluginName}: ${kind} entry "${relFile}" does not exist -- run pnpm run build`,
    )
    return
  }
  const text = readFileSync(filePath, "utf8")
  for (const specifier of extractSpecifiers(text)) {
    if (!isAllowed(specifier)) {
      errors.push(
        `plugins/${pluginName}/${relFile}: ${kind} bundle imports "${specifier}", which is not ` +
          (kind === "server"
            ? "a relative path or a node: builtin (an installed plugin ships with no node_modules)"
            : "a relative path or one of the host's import-map specifiers"),
      )
      continue
    }
    if (isRelative(specifier)) {
      const resolved = resolve(dirname(filePath), specifier)
      const distRoot = resolve(pluginDir, "dist")
      if (!resolved.startsWith(distRoot) || !existsSync(resolved)) {
        errors.push(
          `plugins/${pluginName}/${relFile}: relative import "${specifier}" does not resolve to a ` +
            "file under dist/",
        )
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const { ok, errors } = checkBundles(root)
  if (!ok) {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
  process.stdout.write("+ check-bundles passed\n")
}
