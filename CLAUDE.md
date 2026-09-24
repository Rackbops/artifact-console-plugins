# artifact-console-plugins — Claude Instructions

Third-party plugins for `artifact-console` (see that repo's own `CLAUDE.md` for the host contract).
My personal `~/.claude/CLAUDE.md` governs *how I work*; this file covers only what's specific here.

## The rules that matter here

- **This repo is public. Every workflow job runs on `ubuntu-latest`; no workflow may name
  `self-hosted`.** Public repos never touch the org's self-hosted runner pools (they refuse public
  repos anyway — `allows_public_repositories: false`). `scripts/workflows.test.ts` pins this.
- **A built plugin is self-contained.** The host extracts only `package/package.json` and
  `package/dist/**` from a published tarball — no `node_modules` travels with it. `dist/server.js`
  may import only relative paths and `node:` builtins; `dist/ui.js` only the seven import-map
  specifiers (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `react-router`,
  `@ac/host`, `@rackbops/ui-react`). `pnpm run check-bundles` enforces both — never relax it.
- **Release = a git tag `<id>-v<semver>`**, cross-checked against that plugin's `package.json`
  version and its `CHANGELOG.md` section before anything publishes.
- Run `pnpm run check` before every commit (build, `generate-index --check`, `check-contract`,
  `check-bundles`, biome, typecheck, test — the same gate CI runs).

## The plugin API

Build against the published `@rackbops/ac-plugin-contract` devDependency — its own `AUTHORING.md`
("Building a plugin outside this repo") is the authoring guide, not anything in this repo.
