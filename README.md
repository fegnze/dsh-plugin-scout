# DSH Plugin Scout

[English](README.md) | [中文](docs/zh.md)

[![ci](https://github.com/fegnze/dsh-plugin-scout/actions/workflows/ci.yml/badge.svg)](https://github.com/fegnze/dsh-plugin-scout/actions/workflows/ci.yml) · MIT

Discover and verify DeepSeek Harness plugins published under the GitHub topic `dsh-plugin`, from inside DSH. Plugins are grouped by purpose, ranked by trust score, and checked against the official peer-compatibility rule. Supports DSH **0.2.x** (`>=0.2.0-rc.2 <0.3.0`); tested on desktop 0.2.0-rc.2.

> The in-app UI is currently Chinese only. The plugin's title and description in the official Plugins page are localized (`locale/en.json`, `locale/zh.json`).

## Install

Open the official **Plugins** page → **Add plugin**, and enter one of:

| Spec | Notes |
| --- | --- |
| `dsh-plugin-scout` | Recommended. Prebuilt npm package with provenance; no install scripts, no build approval needed |
| Absolute path of a prebuilt `dsh-plugin-scout-<version>.tgz`, if supplied with a release | Bypasses the npm registry; the current tag workflow creates release notes only and does not attach a tarball |

From the CLI: `dsh plugin --profile <profile> add dsh-plugin-scout`. Enable it on the Plugins page; a **发现插件** (Discover plugins) entry appears in the sidebar.

Do not install from `github:fegnze/dsh-plugin-scout`: a git install fetches source without `lib/`, and this repository deliberately ships no `prepare` script.

## Native Discover index

Add this URL in the official **Plugins → Discover → Index sources** dialog:

```text
https://fegnze.github.io/dsh-plugin-scout/index.json
```

This is a format-1 catalog, not an embedded Scout page. You do not need to install Scout to browse it. GitHub Actions rebuilds it daily at 03:23 UTC and on generator changes, then deploys only after the official DSH validator accepts the document. Failed generation leaves the previous deployment intact.

The public catalog contains deduplicated npm bundles compatible with the target DSH 0.2.1-rc.2, with a matching repository, no install hooks, and advertised provenance. Archived, risky, version-drifted, stale or incomplete entries are excluded. Forks retain a source label. Provenance presence is not cryptographic verification or a security guarantee. Each entry pins the npm version and uses npm's real release time; the official installer remains the final authority. The target runtime is a publishing policy, not a compatibility claim for every DSH release.

Generate from public GitHub/npm data with `GH_TOKEN=<read-only-token> node scripts/generate-market.mjs`. `MARKET_OUTPUT`, `SCOUT_CACHE`, and `DSH_TARGET` override the output, disposable crawl cache, and target runtime. No local profile or user cache is published. The generated `site/index.json` and crawl cache are ignored by Git; CI uploads only the public catalog as the Pages artifact. Adding the source remains your explicit action; Scout does not alter configured index sources.

## One-click install, through the official installer

The **Install** button in the details drawer takes the same path as the official **Add plugin**: `inspect` first, then `installBundle(spec, {enabled: false, requestId, registry})`. Installed plugins start **disabled**; **Enable** is a separate click (`setBundleEnabled`).

- Plugins with install hooks, or whose DSH peers do not cover the running version, need a second click to install.
- When the official installer blocks dependency build scripts (`pendingBuilds`), they are listed by name; a double click on **Allow and reinstall** retries with `approvedBuilds`.
- **Cancel install** calls `cancelInstall` with the same `requestId`; a lost reply is recovered with `waitForInstall`. On failure the official installer restores `package.json` and the lockfile.
- **Uninstalling and version exemptions stay on the official Plugins page.** Scout never calls `removeBundle`; the tests fail if it does. Without the official `pluginManager`, the Install button is hidden and the drawer falls back to "copy pinned spec + open the Plugins page".

## Data sources (first-party only)

| Source | Used for |
| --- | --- |
| GitHub GraphQL `search(topic:dsh-plugin)` | Repository metadata, root `package.json`, `cordis.patch.yml` text (never evaluated) |
| `registry.npmjs.org/<name>/latest` | The manifest that would actually be installed: peers, install hooks, `repository`, provenance |
| Official `pluginManager.listBundles` / `inspect` | Installed state; the official pre-install check (resolves only, runs no code) |
| Official `pluginManager.installBundle` / `waitForInstall` / `cancelInstall` / `setBundleEnabled` | One-click install (disabled by default), cancel, separate enable; progress from `plugin-manager/install-state` and `install-log` events |

No third-party marketplace or aggregator is used. Topic searches explicitly use `fork:true` to include both original repositories and forks; forks retain their source notice and undergo the same checks. After upgrading from 0.1.5 or earlier, use **Rebuild full index** once to discover older forks omitted by the previous search scope.

**Crawling, measured (2026-10):** the topic holds about 19,000 repositories, 12,700 of them created in August, many of them same-name copies. GitHub search returns at most 1,000 results per query, so Scout bisects time windows adaptively (≤900 results per window, 60 s minimum window). Pages are 50 items: 100-item pages return 502 in dense windows, so on 502 the page size steps down to 25, then 10, resuming from the same cursor. Later runs crawl incrementally by `pushed`.

**Refresh is streaming and pays only for what changed:**
- **Newest first.** Windows are seeded geometrically (last 6 h / 1 d / 3 d / 1 w / 1 mo / 3 mo / older) and paged from the newest. Window counting and paging overlap (3 workers).
- **Publish while crawling.** Each page is merged into the record set immediately and published every 1.5 s; the UI reloads the list when `status.rev` changes. The previous index stays usable throughout. A checkpoint is written every 30 s.
- **Pay for change.** With an existing index, a light query fetches metadata only (100 per page, no blobs). Repositories whose `pushedAt` is unchanged keep their facts and only refresh stars and similar metadata; changed ones fetch `package.json` and the patch by node id in batches of 50.
- **npm in parallel.** npm lookups run alongside the GitHub crawl (8 workers), only for repositories with new pushes, missing entries, or entries older than one day. Entries older than one day are refreshed oldest first, at most 800 per run, even when the repository was not seen in that incremental crawl.
- **Canonical source recovery.** A refresh also follows same-name npm packages' GitHub `repository` links with bounded, exact read-only queries. A source is added only when GitHub's actual root manifest declares the same package name; missing topics never justify treating an unrelated namesake as the publisher. Failed lookups do not fabricate source facts.
- **Activation does not wait for the index.** The ~30 MB index loads in the background; the UI first sees `loaded: false` and polls.

Measured on 2026-10-14 over a real network:

| Scenario | First results | Total | Notes |
|---|---|---|---|
| Incremental, 1,082 repos pushed | 4.5 s | 38 s | 125 refetched blobs, 963 metadata-only, 70 npm lookups |
| Cold full crawl | 6.7 s | — | ~1,000 plugins browsable within 60 s; the rest fill in the background |

## Checks and trust score

| Check | Rule | Points |
| --- | --- | --- |
| V1 | Root `package.json` declares `dsh.bundle` / `dsh.client` (otherwise not a plugin) | 20 |
| V2 | Official peer rule: only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`, `semver.satisfies(runtime, range, {includePrerelease})`, `workspace:*` means the running version. Inside the App, Scout calls `dsh-app-boot.evaluatePluginCompatibility` directly | covered 30 · no peers 10 · not covered 5 |
| V3 | Install hooks: preinstall / install / postinstall / prepare | none +15 · present −15 |
| V4 | Source chain: the same-name npm package's `repository` points back to this repo | match +15 · mismatch −20 · unpublished 0 |
| V5 | npm provenance | +10 |
| V6 | Activity: archived, pushed within 90 days, version drift (V6b) | +5 / −10 |
| V9 | Uses the `@deepseek-ai/` scope but the repo is not owned by deepseek-ai | −30 |
| V10 | Fork | note only |
| — | Stars: `min(5, round(log10(1+s)·2))` | ≤5 |

The total is clamped to 0–100. Any ✕ marks the plugin as **risky**: copying its spec or installing it takes two clicks, and its badge shows ✕. Repositories sharing a package name collapse under one representative, chosen by: matching source chain > score > stars > earliest creation. The rest are listed as copies, hidden by default.

Ten purpose categories: UI, session, memory, agent, tools, models, security, development, bridges, domain. A category is scored from the official packages a plugin depends on (highest weight), topics/keywords (3), and text (2); a plugin is categorized only with a score of at least 2. On 41 hand-labelled plugins, the top-1 category is correct for at least 35.

## UI and integration points

- **Discover page:** sidebar **发现插件** → `main` panel with search, filters (compatibility, risk, kind, installed state, copies), category chips, sorting and paging.
- **Details drawer:** checklist, score breakdown, category evidence, source chain and copies, surface (cordis inserts, `client.inject`, peers), and the official pre-install check. Footer:
  - **Install / Enable / Cancel install**, as described above.
  - **Copy pinned spec:** copies `name@npmVersion`, or `github:owner/repo` when unpublished.
  - **Open in Plugins page / Add on Plugins page:** installed plugins open their official details via `pluginNavigation.openBundle`; others switch to the official Plugins page.
- **Official Plugins page:** `plugins.detail.badge` (trust score) and `plugins.detail.section` (checklist plus a link back to Scout). Packages missing from the index render `null`, taking no space.

## Development

```sh
npm install --ignore-scripts
npm test          # builds lib/, then runs the core / host / client / manifest suites
```

Local debugging: add this directory's absolute path on the Plugins page (a link install; do not move the directory). Host changes need a full App restart; client-only changes need a window reload.

**GitHub token**, in order: `DSH_SCOUT_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`, or `gh auth token` run through the DSH subprocess service. The token stays in process memory: never written to disk, never sent to the browser. Without one, the page asks you to run `gh auth login`.

## Data and configuration

- Index: `~/.dsh/dsh-plugin-scout/index.json` stores facts only (repo metadata, slimmed manifests, npm cache) and is re-judged against the current runtime on every load, so compatibility verdicts follow DSH upgrades automatically.
- Auto refresh: an in-process timer checks 45 s after start and runs an incremental crawl when the index is older than `autoRefreshHours` (default 24; 0 disables). No LaunchAgent or external scheduler.
- Optional config: `dataDir`, `topic`, `runtimeVersion` (overrides runtime detection), `autoRefreshHours`.

## Security boundaries

- Routes live on DSH's own webServer (`/dsh-plugin-scout/api/*`). Every request must carry the custom header `x-dsh-plugin-scout: 1` and pass DSH `connection.admit` (Host/Origin fence plus browser auth). Without the `connection` service, requests are refused (fail closed).
- `cordis.patch.yml` is scanned for `name:` with a regex; YAML tags are never parsed. Crawled code is never executed and tarballs are never downloaded.
- Style tags carry `data-plugin` / `data-plugin-css` before entering the DOM. Only `--dsw-alias-*` tokens are used; class names avoid substrings that host skins target; the drawer does not use `role="dialog"`.

## Layout

- `src/core/`: `classify.mjs` (categories), `verify.mjs` (checks and score), `crawl.mjs` (GraphQL, windows, npm), `store.mjs` (fact index, queries).
- `src/host.mjs`: runtime and token detection, refresh state machine, same-origin routes, in-process timer.
- `src/client/`: Discover page, drawer, installer, official-page badge/section, styles.
- `scripts/build.mjs`: esbuild bundling; both artifacts are **executed** after writing, as the gate.
- `test/`: `core` (real GraphQL page, 41 labelled samples), `host` (fake-fetch end-to-end refresh, route auth), `client` (Happy DOM loading the built artifact), `manifest` (official packaging conventions).

After a DSH upgrade, re-check the official Plugins page slot names, the `pluginManager` methods, and the `dsh-app-boot` exports before re-accepting.

## Official conventions followed

Based on the official repository's `docs/user/develop/basic/publish`, `docs/cookbook/adding-a-package` §5, and the `@deepseek-ai/dsh-package-manifest` types; `test/manifest.test.mjs` asserts each one.

| Convention | This package |
| --- | --- |
| Bundle: `dsh.bundle.patch`; patch rows reference the package **by name** | `./cordis.patch.yml` → `name: 'dsh-plugin-scout'` |
| Only public author fields under `dsh` | `manifestVersion: 1`, `bundle`, `client` (`platform: web`) |
| Display metadata: `locale/en.json` is the entry, other languages use the same fields; export `./locale/*.json` and `./package.json`, and ship them | `meta.title` / `meta.description` in `en.json` and `zh.json` |
| Icon: relative path inside the package, ≤256 KiB, self-contained | `./icon.svg` |
| Packages sharing host instances are peers; the version gate reads only `@deepseek-ai/dsh*` peers | `@deepseek-ai/cordis ~4.0.4`; `@deepseek-ai/dsh-app-boot >=0.2.0-rc.2 <0.3.0` (optional, declares the range for the official gate) |
| `engines.dsh` is declarative | `>=0.2.0-rc.2 <0.3.0` |
| Ship prebuilt artifacts; never ask users to approve builds | Published to npm with `--provenance`; no `prepare` or other install hooks |

## Releasing

1. Prepare the intended `version` in `package.json` and commit the release changes to `main`.
2. Manually dispatch `publish.yml` from `main` with `expected_sha` set to the full approved commit SHA. Keep `dry_run: true` (the default) for validation first: the workflow checks the SHA, installs dependencies without lifecycle scripts, runs tests (including the build), and previews the package with `npm pack --dry-run --ignore-scripts`. A dry run does not publish. For an approved release, dispatch the same SHA with `dry_run: false` to run `npm publish --access public --provenance --ignore-scripts`.
3. npm authenticates through Trusted Publishing (OIDC), so no npm token is stored in the repository; provenance is attached automatically. Configure npmjs.com → package Settings → Trusted Publisher for this GitHub repository and workflow `publish.yml`, or use `npx npm@latest trust github dsh-plugin-scout --file publish.yml --repo fegnze/dsh-plugin-scout`.
4. Separately, `git tag v<version> && git push origin v<version>` triggers `release.yml`. It checks that the tag matches the package version and creates a GitHub Release with generated notes only; it neither publishes to npm nor builds or attaches a tgz. Supply a prebuilt archive separately if offering tarball installation.
5. Keep the repository public with the `dsh-plugin` topic so it appears on https://github.com/topics/dsh-plugin and in Scout itself.
