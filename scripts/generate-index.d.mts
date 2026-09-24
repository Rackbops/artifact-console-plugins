// Types for generate-index.mjs (a plain-JS script), so generate-index.test.ts imports it typed —
// the same pattern artifact-console's own scripts/generate-index.d.mts uses.
export interface Release {
  version: string
  date: string
  notes?: string
}

export interface PluginIndexEntry {
  host: string
  name: string
  package: string
  version: string
  hostApiVersion: number
  env: unknown[]
  releases: Release[]
}

export interface PluginIndex {
  schemaVersion: number
  plugins: PluginIndexEntry[]
}

export function parseChangelog(text: string): Release[]
export function generateIndex(pluginsDir: string): PluginIndex
