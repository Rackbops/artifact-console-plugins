# research-feed-store: a no-runtime-dependency Node/TypeScript sidecar (#453 decision 1). Two
# stages -- build compiles src/ to app/ with tsc; runtime ships only app/ + package.json, nothing
# else (no node_modules -- there is nothing to install; node:http, node:sqlite and global fetch are
# all built into Node 26).
#
# The Node base is pinned to an exact version plus its digest, and the two build tools to the versions
# the workspace lockfile resolves, so a release builds what the tests ran against. dockerfile.test.ts
# keeps both honest. Renovate's dockerfile manager bumps the FROM tag + digest through a PR; the two
# npm pins are not visible to it, so a catalog bump fails that test until they are edited by hand.
#
# Deliberately no ARG, ENV or LABEL anywhere in this file naming RESEARCH_FEED_URL,
# RESEARCH_FEED_TOKEN, RESEARCH_FEED_ACCESS_CLIENT_ID, RESEARCH_FEED_ACCESS_CLIENT_SECRET,
# RESEARCH_FEED_POLL_SECONDS or RESEARCH_FEED_DB -- every credential and config value is
# runtime-only, supplied at `docker run`/`docker compose up` via env_file, never baked into an
# image layer (see plugins/research-feed-store/CLAUDE.md-equivalent note in README.md).

FROM node:26.12.1-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS build
WORKDIR /app
# Deliberately does NOT copy package.json before this install: its devDependencies use pnpm's
# `catalog:` protocol (resolved only inside the pnpm workspace), which plain npm chokes on
# (EUNSUPPORTEDPROTOCOL) the moment a package.json naming it is present in the working directory --
# even for an unrelated `npm install <pkg>@<version>` command. Installing into an empty directory
# sidesteps that entirely; the runtime stage's own `COPY package.json ./` (below) is unaffected,
# since nothing ever runs `npm install` there.
RUN npm install --no-save --no-audit --no-fund typescript@7.0.2 @types/node@26.6.5
# package.json is copied AFTER the install above (never before it -- see the comment on that RUN),
# but IS needed for this tsc run: its "type": "module" is how TypeScript's nodenext module
# detection decides these .ts files are ESM, not CommonJS -- without it present, tsc silently
# treats every file as CommonJS and every `export`/`import` statement becomes a hard error.
# tsconfig.build.json (used by `pnpm -r build` from the repo root) extends ../../tsconfig.base.json
# -- unreachable from here, since this build's context is scoped to this directory alone. This
# image builds with its own self-contained tsconfig.docker.json instead (kept in sync with
# tsconfig.base.json + tsconfig.build.json's own overrides by tsconfig-docker-drift.test.ts).
COPY package.json tsconfig.docker.json ./
COPY src ./src
RUN npx tsc -p tsconfig.docker.json

FROM node:26.12.1-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS runtime
WORKDIR /app
COPY --from=build /app/app ./app
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "app/main.js"]
