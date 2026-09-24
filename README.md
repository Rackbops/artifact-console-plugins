# artifact-console-plugins

Third-party plugins for [artifact-console](https://github.com/Rackbops/artifact-console), the
TypeScript plugin host. Each plugin here is an ordinary npm package (`@rackbops/ac-plugin-<id>`)
built against the published [`@rackbops/ac-plugin-contract`](https://www.npmjs.com/package/@rackbops/ac-plugin-contract)
ABI, and this repo's committed `plugins.json` is a self-hosted index a console can point
`AC_PLUGINS_INDEX_URLS` at to discover and install them.

## The index

The index is the committed `plugins.json`, served from its raw URL:

```
https://raw.githubusercontent.com/Rackbops/artifact-console-plugins/main/plugins.json
```

It's generated (never hand-edited) by `pnpm run generate-index` from each `plugins/<id>/package.json`'s
`acPlugin` block and `CHANGELOG.md`. `pnpm run check` runs it in `--check` mode, which fails naming
`plugins.json` when the committed file doesn't match a fresh generate.

## Adding a plugin

1. Add a new `plugins/<id>/` package, laid out like `plugins/hello-remote/`: `package.json` (with an
   `acPlugin` manifest block, `name: "@rackbops/ac-plugin-<id>"`, and a `repository` field pointing at
   this repo and `plugins/<id>`), `CHANGELOG.md`, `src/server.ts` (and `src/ui.tsx` for a frontend),
   and the four tsconfigs.
2. Build against `@rackbops/ac-plugin-contract` — see its own `AUTHORING.md` ("Building a plugin
   outside this repo") for the plugin API. An installed plugin ships with no `node_modules`: its
   server may import only relative paths and Node builtins, and its frontend only the host's seven
   import-map specifiers (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
   `react-router`, `@ac/host`, `@rackbops/ui-react`). `pnpm run check-bundles` enforces both.
3. Run `pnpm run generate-index` and commit the resulting `plugins.json` alongside the new plugin.
4. Open a PR; `pnpm run check` runs in CI.

## Release flow

A release is a git tag `<id>-v<semver>` (e.g. `hello-remote-v0.1.0`), pushed to `main`. The
`publish.yml` workflow:

- resolves the plugin name and version from the tag,
- requires the tagged package's `package.json` version to match the tag and its `CHANGELOG.md` to
  carry a matching section,
- runs `pnpm run check`,
- publishes to npm via `pnpm publish` (OIDC trusted publishing, provenance attached),
- creates a GitHub release with the CHANGELOG section as its notes.

### Operator bootstrap (once per new package)

npm cannot register a trusted publisher for a package that doesn't exist yet, and won't let a
workflow republish an already-existing version — so a brand new package's very first version is
always published by hand:

1. `pnpm --filter @rackbops/ac-plugin-<id> build && pnpm --filter @rackbops/ac-plugin-<id> publish --access public`
   (2FA required).
2. On npmjs.com, under that package's Settings → Trusted Publisher, add a GitHub Actions publisher:
   organization `Rackbops`, repository `artifact-console-plugins`, workflow `publish.yml`, environment
   left blank.

Every version after that publishes automatically from a pushed tag.

## Installing from a console

On an `artifact-console` host, add this repo's raw `plugins.json` URL as a plugin index (Admin →
Plugins → Indexes), then pin a version of the plugin you want — see that repo's `CLAUDE.md` for the
install-core surface (`GET`/`POST`/`DELETE /api/plugins/indexes`, `GET /api/plugins/install/offers`,
`POST /api/plugins/install/pin`).
