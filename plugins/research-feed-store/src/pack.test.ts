import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"

// A kind: "sidecar" plugin ships no files on npm: its manifest lives in package.json and the app
// ships as a container image. `"files": []` in package.json is what keeps src/, the Dockerfile,
// the tsconfigs, deploy/ and the CHANGELOG out of the tarball; there is no .npmignore (#28). The
// publish workflow runs `pnpm publish`, so `pnpm pack` is the same file selection.
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("the npm tarball holds exactly LICENSE, package.json and README.md", () => {
  const dest = mkdtempSync(join(tmpdir(), "research-feed-store-pack-"))
  dirs.push(dest)
  execFileSync("pnpm", ["pack", "--pack-destination", dest], { cwd: pluginDir, stdio: "pipe" })
  const tarballs = readdirSync(dest)
  expect(tarballs).toHaveLength(1)
  const listing = execFileSync("tar", ["-tzf", join(dest, tarballs[0] ?? "")], {
    encoding: "utf8",
  })
  const files = listing
    .split("\n")
    .filter((line) => line !== "")
    .sort()
  expect(files).toEqual(["package/LICENSE", "package/README.md", "package/package.json"])
})
