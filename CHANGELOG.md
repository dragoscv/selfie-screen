# Changelog

All notable changes to TikSee. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow SemVer.

## [Unreleased]

### Added
- **Instant clips**: the Studio keeps the last 15/30/60 seconds of what viewers see, encoded on the GPU (about 30 MB of memory at 8 Mbps × 30 s). Press Ctrl+Shift+K, add the "Save clip" studio action to a rule, or press Highlight to save an MP4 to Videos\TikSee. Settings → Studio → Instant clips.
- **New pets**: all seven pets rebuilt as proper models (parrot, cat, dragon, drone, fox, owl, red panda) with faces, blinking eyes, lip-sync and new moves (walk, hop, wave).
- **Pets live in 3D around you**: they perch on your shoulders, head or a raised hand, fly around your head (passing behind you) and hop between spots; they wave back when you wave, hop to a heart and go where you point. When you leave the frame they wait at the bottom edge instead of vanishing.
- **3D debug view** (F3 in the Studio): your skeleton in metres, the floor, your shoulder height and where every pet is heading. Preview only.
- **Smart pets**: each pet has its own needs, mood and personality and decides for itself what to do (perch, land on your open palm, listen to the co-host, play with the other pet, doze off when the stream is quiet, celebrate big gifts). Pets never pass through you or each other, take turns reacting, and move with breathing, springy tails and ears, gaze jumps and landing squash. Optional AI director nudges them from the chat mood (off by default).
- **3D space calibration** (Studio → Camera → Calibrate 3D space): camera model and lens, your height, stand up and sit down for a few seconds; optional precise lens calibration with a printed board and a one-time scene analysis. Pets and effects are then sized correctly for your room.
- **Touch the pets with your hands**: pinch a pet to pick it up and move it; while holding it, pinch with the other hand and spread or close your hands to resize it (the size is kept, the pet goes back to doing its own thing when you let go). Hand depth comes from the hand itself, checked against your arm.
- **Talking pets**: pets say short things in speech bubbles that viewers see in the video, comment on what you do and on the chat, and can optionally speak (off by default, never in Shop mode). Studio dock → AI: AI level (Off / Local / Reactive / Chatty / Director), how much chat they read (None / Activity / Mentions / Full), bubbles, voice and an hourly call cap. At Director level the AI can also move pets around you.
- **Pets grow a personality**: each pet has its own traits and memories (big gifts, being picked up, regular viewers) that change slowly over streams and are kept until you reset them (Studio dock → AI → hold to reset).
- **Gesture calibration** (Calibrate 3D space → Hands & gestures): perform each gesture, then a check pass with a score per gesture; TikSee learns your pinch and your palm size.
- **Camera mount**: tell TikSee how high your camera is and how much it looks down (or let it estimate the tilt), so the 3D space matches your room. Settings → Studio.

### Changed
- Pets, AR objects and effects share one real 3D space (perspective, metres), so sizes and in-front/behind are consistent.
- The Studio renders at 60 fps by default (the camera rate) instead of the monitor refresh, using much less GPU; Settings → Studio → Preview frame rate.

### Fixed
- Pets no longer flicker, jump between positions or disappear when your shoulders leave the frame.
- The body skeleton moves smoothly (about 40× less jitter) and pets keep their size when you turn or move your arms.
- Gestures: hands of other people no longer trigger your gestures, left/right no longer swap, hands partly out of the frame no longer fire false gestures, OK and pinch are told apart, swipes and waves survive a dropped frame, and hand points are smoothed.
- Re-running the face calibration no longer resets other calibration values.

## [0.3.0] — 2026-10-06

### Added
- **TikSee Camera** — a native Windows virtual camera (no OBS). TikTok LIVE Studio, Zoom or any app can select it; it carries the studio picture at 1080×1920 or 1920×1080, 30/60 fps, and shows an "offline" frame when TikSee is closed. Installed by the setup; "Repair camera" in Settings → Studio.
- **Vision**: hand and finger gestures (thumbs, victory, 🤟, OK, rock, pinch, finger counts, heart, frame, T-timeout, prayer, clap, two-hand zoom, swipes, circle, wave), facial expressions and winks with per-eye calibration, head nod/shake/tilt, posture, talking/laughing/drinking/phone states, energy meter, people and dogs entering/leaving. Everything runs locally.
- **Rules with if/else chains**: triggers (gestures, chat, gifts, follows, controls, timers) → conditions → actions (camera, studio, AR effects, pets, voice, smart-home, highlights) with wait, repeat, parallel and variables; list editor and node-graph editor over the same rule; sensitive rules require "arming" with an open palm.
- **Vision log**: every state change with its duration, stats per signal, CSV export, retention.
- **People and pets (beta)**: enrol yourself, guests and your dogs; recognition stays on this PC and unknown people are never stored.
- **Tutorial and calibration** for gestures, winks, expressions and body distance.
- **Pro Studio controls** over the preview: zoom and focus over Bluetooth (hold buttons, speeds, AF), digital zoom, auto-reframe, synthetic depth of field, focus loupe; focus peaking, zebras, false colour, clipping, histogram/waveform/vectorscope, guides, TikTok LIVE safe zones with a guardian, horizon level, exposure assistant, coaching nudges. None of it reaches the stream.
- **AR objects in depth**: emoji, text, images and pet models placed in 3D; walk in front of or behind them. Gift-triggered effects.
- **Studio button** in the main window title bar.
- USB PC Remote panel for ISO/WB/shutter (opt-in; it blanks HDMI while connected).

### Changed
- The Studio window keeps its 9:16 / 16:9 ratio while resizing; its controls adapt to any window size.
- Rounded, evenly spaced cards and controls across the main window (theme radius tokens were broken).
- Vision runs in a background worker: studio render 180 fps, vision ~18 ms per frame.

### Fixed
- Overlays no longer flicker when a gesture or face drops out for a frame.
- Studio camera buttons work when the Studio opens after the remote connected.
- Dev server port moved to 15373 (Windows reserved the old one).

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
