# TikSee — agent instructions

TikTok LIVE studio for Windows. Canonical tracking: `docs/PROJECT.md` (decisions,
architecture, status) and `docs/backlog.csv` (one row per item, 10 columns, no
commas inside fields). Update both in the same change as the code.

## Layout
- `packages/core` — Zod wire contract (`protocol.ts`, `live.ts`), settings, aggregation. Change here first; both sides break at compile time.
- `apps/sidecar` — Node 24 service: TikTok ingest, co-host brain (`src/cohost`), viewer memory (`node:sqlite`), vmui effects, OBS overlay server, LCD panel. Owns every decision.
- `apps/desktop` — Tauri 2 shell (`src-tauri`, Rust 2024) + React 19 renderer. Owns mic/speaker (WebAudio) and UI only.
- `apps/android` — legacy origin app; build-only upgrades.

## External services
- codai gateway `https://ai.codai.ro`: `codai-fast` replies, `/v1/audio/speech/stream` (`codai-tts-ro`, visemes), `/v1/realtime?model=codai-transcribe-live&language=ro`, `/v1/systemone` batch. Renderer uses short-lived `live` tokens minted by the sidecar.
- vmui MCP `http://192.168.100.232:3737/api/mcp` (`scene_set`, `flash_color`, limiter returns `limited:true`).
- Keys live in Windows Credential Manager, keyring target `<user>.ro.codai.tiksee` (`codai-api-key`, `vmui-api-key`, `tiktok-session`). Never log or expose them to the renderer.

## Gates (all must pass, zero warnings except the known React Compiler `useVirtualizer` one)
- `pnpm verify` (typecheck, lint, test, build) + `pnpm budgets` (gzip size budgets).
- `cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test --lib` in `apps/desktop/src-tauri`.
- Hooks: `.githooks` (installed by `pnpm install` via `prepare`). CI: `.github/workflows/ci.yml`.
- i18n parity test fails when `en.json`/`ro.json` key sets drift.

## Gotchas
- Fresh clone: build `@tiksee/core` + `@tiksee/sidecar` before `tauri dev`.
- Vite dev port 15373: WinNAT reserves shifting 100-port blocks below 10000 (5373 hit EACCES on 2026-10-06); check `netsh interface ipv4 show excludedportrange protocol=tcp`.
- zustand selectors must return stable references.
- Webview entry files: disposed-flag for `listen()`; cache `createRoot` on `window`.
- pnpm `minimumReleaseAge: 1440`: a version published < 24 h ago fails install; pin the previous one.
- TypeScript 7 removed `baseUrl`; use `paths` relative to the tsconfig.
- Release: `scripts/release.ps1 [-Publish -Notes '...']` from a clean tree (deploy-clean). Bump `version` in `tauri.conf.json`, `apps/desktop/package.json`, root `package.json`, `CHANGELOG.md` together. Signing key `%USERPROFILE%\.tauri\tiksee.key`, password in Credential Manager `tauri-signing.ro.codai.tiksee`; updater reads `https://storage.googleapis.com/tiksee-releases/latest.json`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
