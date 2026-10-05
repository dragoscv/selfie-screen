---
name: tiksee-live
description: Work on the TikSee live studio (E:\gh\selfie-screen) — co-host brain, voice (codai TTS/STT), Live Control, viewer memory, vmui effects, Tauri shell, releases. Use when changing the sidecar co-host, the renderer audio engine, the wire contract, settings, or when going live / debugging a live session.
---

# TikSee live studio

## Before editing
1. Read `docs/PROJECT.md` §4 (decisions Q1–Q32) and §10 (architecture), and the relevant `docs/backlog.csv` rows.
2. Contract first: `packages/core/src/live.ts` + `protocol.ts` + `settings.ts`. Rebuild core (`pnpm --filter @tiksee/core build` via run-build) before the apps typecheck.
3. Every settings field must be read by code (sidecar: assistant/safety/effects/data/behaviour.triggerServerEnabled; renderer: voice/audio/appearance/overlay). A field nobody reads is a bug.

## Data flow (who owns what)
- Sidecar decides: scorer (deterministic) → token bucket → reply queue → responder (codai-fast streamed) → speaking gate → `say`.
- Renderer plays: `say` → `/v1/audio/speech/stream` (PCM16 24 kHz + visemes) → WebAudio on the chosen sink → `sayState` + `speechTimeline` back. Mic → `/v1/realtime` → `transcript` to the sidecar.
- Speaking gate never speaks while muted, Shop LIVE, replies paused (except manual `speak`), within `quietAfterStreamerMs` of the streamer, or over another utterance.
- Effects: `!color`/`!scene` chat commands and gift tiers → vmui MCP; `limited:true` is success. Viewers never get scenes unless `allowedChatScenes` lists them.

## Verify a live path without going live
- Replay (`~/.tiksee/replays`) or `simulate` messages drive feed, queue, read-aloud and effects.
- Sidecar smoke: `node apps/sidecar/dist/index.js` prints `TIKSEE_SIDECAR_READY {...}`.
- Stream Deck: `POST http://127.0.0.1:<overlayPort>/control/<action>` with `x-tiksee-token` from `%APPDATA%\ro.codai.tiksee\trigger-token.txt`.
- codai usage for the TikSee key (id 7b5505d0…): read `usage_events` (latency_ms, ttfb_ms) filtered by api_key_id, read-only.

## Gates
`pnpm verify`, `pnpm budgets`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`. Builds only through `~/.copilot/hooks/run-build.ps1`; installs through agentq.

## Traps already paid for
- Credential Manager targets are `<user>.<service>` (keyring 3), blob UTF-16LE.
- `node:sqlite` prints an ExperimentalWarning — suppressed narrowly in the sidecar.
- The pcm worklet must be a standalone file (CSP has no `blob:` for scripts).
- pnpm release-age quarantine (24 h) rejects fresh versions: pin the previous one.
