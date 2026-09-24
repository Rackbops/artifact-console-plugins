// A test-only stand-in for the "@ac/host" specifier, which at runtime resolves through the host
// page's import map to its own /vendor/ac-host.js (there is no real module to resolve to outside a
// running console) -- aliased in vitest.config.ts, then replaced per test with vi.mock. Not part of
// the published package: excluded from every tsconfig's `include`, so it never ships in dist/.
export function fetch(_path: string, _init?: RequestInit): Promise<Response> {
  throw new Error('ac-host.stub: fetch was not mocked -- call vi.mock("@ac/host", ...) first')
}
