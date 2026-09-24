// Types for check-bundles.mjs (a plain-JS script), so check-bundles.test.ts imports it typed.
export function extractSpecifiers(text: string): string[]
export function checkBundles(root: string): { ok: boolean; errors: string[] }
