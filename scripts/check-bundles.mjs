import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

// checkBundles(root): an installed plugin ships with NO node_modules -- the host extracts only
// package/package.json and package/dist/** from a published tarball -- so a built plugin's own
// dist/ must be self-contained. For each plugins/*/package.json's `acPlugin.server` (Node builtins
// and relative imports only) and `acPlugin.frontend` (the host's seven import-map specifiers, plus
// relative imports), every static import/export...from, bare `import "spec"`, CommonJS `require(...)`,
// and dynamic `import(...)` specifier is checked -- TRANSITIVELY: a relative import is followed into
// the file it points at and that file's own specifiers are checked too (a helper module split out of
// the entry file is just as unshippable-if-wrong as the entry file itself), with a visited set so a
// cyclic pair of helpers can't loop forever. A relative specifier must additionally resolve to a real
// file *under* dist/ -- compared with a trailing separator, not a bare string prefix, so a sibling
// directory that merely SHARES dist/'s name as a prefix (e.g. "../dist-secret/x.js" against a
// ".../dist" root) is correctly rejected rather than accepted by accident.

const FRONTEND_SPECIFIERS = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "react-router",
  "@ac/host",
  "@rackbops/ui-react",
])

// Matches `import ... from "spec"` / `export ... from "spec"` (from-clause, allowed to span multiple
// lines -- a hand-formatted or non-tsc bundle can wrap a long import list across lines), bare
// `import "spec"`, dynamic `import("spec")`, and CommonJS `require("spec")`. Deliberately simple
// (four regexes, not a real parser): good enough to catch an ordinary bundle's imports, not a
// guarantee against deliberately obfuscated code (a computed specifier, e.g. `import(someVariable)`,
// is invisible to a regex either way -- such a plugin fails at install/runtime instead, since there's
// no node_modules for a bare computed import to resolve against there either).
const FROM_CLAUSE_RE = /\b(?:import|export)\b(?:(?!from|['";]).)*\bfrom\s*(['"])((?:(?!\1).)*)\1/gs
const BARE_IMPORT_RE = /^\s*import\s*(['"])((?:(?!\1).)*)\1/gm
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])((?:(?!\1).)*)\1/g
const REQUIRE_RE = /\brequire\s*\(\s*(['"])((?:(?!\1).)*)\1/g

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractSpecifiers(text) {
  const specifiers = []
  for (const re of [FROM_CLAUSE_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
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
 * True when `path` is exactly `root`, or a real descendant of it -- a boundary-aware check (compares
 * against `root + sep`), not a bare string-prefix compare, which a sibling directory sharing `root`'s
 * name as a prefix (e.g. "dist-secret" against "dist") would otherwise falsely satisfy.
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
function isUnder(path, root) {
  return path === root || path.startsWith(root + sep)
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
      checkEntry(pluginDir, manifest.server, "server", isServerSpecifierAllowed, errors, dir.name)
    }
    if (typeof manifest.frontend === "string") {
      checkEntry(
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

/** Checks `relFile` and, transitively, every relative import it (and its own helpers) resolve to. */
function checkEntry(pluginDir, relFile, kind, isAllowed, errors, pluginName) {
  const distRoot = resolve(pluginDir, "dist")
  const visited = new Set()
  checkFile(pluginDir, relFile, kind, isAllowed, errors, pluginName, distRoot, visited)
}

function checkFile(pluginDir, relFile, kind, isAllowed, errors, pluginName, distRoot, visited) {
  const filePath = resolve(pluginDir, relFile)
  if (visited.has(filePath)) return
  visited.add(filePath)

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
      if (!isUnder(resolved, distRoot) || !existsSync(resolved)) {
        errors.push(
          `plugins/${pluginName}/${relFile}: relative import "${specifier}" does not resolve to a ` +
            "file under dist/",
        )
        continue
      }
      // Follow the import transitively: a helper module split out of the entry file must obey the
      // same rules as the entry file itself (relative to pluginDir, so nested helpers keep resolving
      // correctly at any depth).
      const relFromPlugin = resolved.slice(pluginDir.length + 1)
      checkFile(pluginDir, relFromPlugin, kind, isAllowed, errors, pluginName, distRoot, visited)
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
