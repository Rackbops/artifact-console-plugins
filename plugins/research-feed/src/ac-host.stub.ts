// A test-only stand-in for the "@ac/host" specifier -- see hello-remote's own copy of this file for
// the full explanation. Not part of the published package: excluded from every tsconfig's
// `include`, so it never ships in dist/.
export function fetch(_path: string, _init?: RequestInit): Promise<Response> {
  throw new Error('ac-host.stub: fetch was not mocked -- call vi.mock("@ac/host", ...) first')
}

export function cached(
  _path: string,
  _init?: RequestInit,
  _opts?: { ttlMs?: number },
): Promise<Response> {
  throw new Error('ac-host.stub: cached was not mocked -- call vi.mock("@ac/host", ...) first')
}
