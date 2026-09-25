import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

/**
 * tsconfig.docker.json (used only by the Dockerfile, whose build context can't reach the repo
 * root's tsconfig.base.json -- see that file's own $comment) duplicates tsconfig.base.json's
 * compilerOptions plus tsconfig.build.json's own overrides, rather than `extends`ing them. This
 * test fails the moment either upstream file changes without this one being updated to match --
 * the guard tsconfig.docker.json's own header promises.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url))
const pluginDir = fileURLToPath(new URL("..", import.meta.url))

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"))
}

test("tsconfig.docker.json's compilerOptions equal tsconfig.base.json + tsconfig.build.json's own overrides", () => {
  const base = readJson(`${root}/tsconfig.base.json`) as {
    compilerOptions: Record<string, unknown>
  }
  const build = readJson(`${pluginDir}/tsconfig.build.json`) as {
    compilerOptions: Record<string, unknown>
    include: string[]
    exclude: string[]
  }
  const docker = readJson(`${pluginDir}/tsconfig.docker.json`) as {
    compilerOptions: Record<string, unknown>
    include: string[]
    exclude: string[]
  }

  const expectedOptions = { ...base.compilerOptions, ...build.compilerOptions }
  expect(docker.compilerOptions).toEqual(expectedOptions)
  expect(docker.include).toEqual(build.include)
  expect(docker.exclude).toEqual(build.exclude)
})

test("the Dockerfile builds with tsconfig.docker.json, not tsconfig.build.json", () => {
  const text = readFileSync(`${pluginDir}/Dockerfile`, "utf8")
  expect(text).toMatch(/tsc -p tsconfig\.docker\.json/)
  expect(text).not.toMatch(/tsc -p tsconfig\.build\.json/)
})
