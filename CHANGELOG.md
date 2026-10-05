# Changelog

All notable changes to TikSee. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow SemVer.

## [0.2.0] — 2026-10-05

### Added
- **Live Control bar** (mute assistant, pause replies, skip, effects off, Shop LIVE, hide pets, highlight) with global hotkeys and Stream Deck HTTP triggers.
- **AI co-host "Codai"**: deterministic reply scoring, token bucket (~4/min), approvable reply queue, codai-fast streamed replies, never talks over the streamer, Romanian by default.
- **codai voice**: Romanian neural TTS (`codai-tts-ro`, Alina/Emil) with visemes, selectable output device (Voicemeeter-friendly) and ducking while the streamer talks.
- **Live transcription** of the streamer's microphone (`codai-transcribe-live`, Romanian).
- **Viewer memory** (local SQLite): returning-viewer cards with visits, gifts and remembered facts.
- **Teleprompter**: unanswered questions, quiet chat, pending thanks, activity spikes.
- **Smart-home effects via vmui**: `!colour` chat commands with cooldowns, gift tiers for scenes, kill switch.
- **Auto-updater** from `storage.googleapis.com/tiksee-releases` (signed).
- CI, size budgets, i18n parity test, agent instructions.

### Changed
- Installer bundles its own Node runtime; Node is no longer required on the machine.
- Toolchain: pnpm 12, Node 24, TypeScript 7 (dual install), Vitest 5, tsdown, React 19.3, Tauri 2.12, Rust 2024, Motion 14.
- Voice settings moved from Azure OpenAI deployments to codai.

### Fixed
- First-launch "Invalid hook call" on the Live page.
- TikTok session login is captured and used; hotkeys now act; sidecar restarts after a crash; dead WebSocket connections are detected.
- Hardcoded English strings translated.

## [0.1.0] — 2026-08-12

- First desktop release: live chat feed, analytics, people, OBS browser source, Turing LCD panel, replay.
