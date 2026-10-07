# Changelog

All notable changes to TikSee. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow SemVer.

## [Unreleased]

### Added
- **Rotate in every direction with the ⟳ ring**: left / right turns the object or pet both ways (through ±180°), up / down tilts it forward or back, a diagonal drag does both, like orbiting a 3D model; Shift = roll on screen (AR objects). AR objects get a **Tilt** slider; keyboard `[` `]` turn and `,` `.` tilt. The readout shows ↔ turn and ↕ tilt while you drag.
- **Edit in view (3D)** in the AR panel: one switch turns the preview into a 3D editor for every scene object, AR objects and pets alike. Click to select; drag to move; the red X, green Y and blue Z arrows move along one axis (Z = nearer / farther); the corner resizes; the ⟳ ring turns it (Shift = roll for AR objects). Wheel = depth, Alt+wheel = size, arrows / Page Up / Page Down / + / − / [ ] from the keyboard. A pet stays exactly where you leave it (📌, saved) until you press Release; its size is saved too. The panel folds away so the whole picture is free. AR objects can now also turn around the vertical (new Turn slider).
- **Pet switch morph**: changing a pet no longer cuts. The old pet grows a little, squashes and spins down into nothing where it stands while a sparkle burst covers the swap, and the new pet pops in at the same spot with an elastic stretch that settles (about 0.75 s, smooth at 60 fps).
- **Live captions on the stream**: under Monitor → Audio → Transcript, **Show on the live** draws your words into the video your viewers see, as a modern caption strip that morphs to each sentence, pops in and fades out when you stop talking. **Second language** adds each sentence translated (pick the language: English, Spanish, Italian, French, German and more). Choose the look (Glass, Solid, Minimal), 1–3 lines and the size. By default it sits between your face and TikTok's comment area; in the preview drag it to move, pull the corner or use the mouse wheel to resize, double-click to reset, with a small floating toolbar for the look.
- **Sound button in the Studio dock**: choose the voice output and the microphone, the co-host's voice, volume, speed and pitch, how much it lowers while you talk, and for each pet on screen its own voice, speed and pitch, each with a ▶ Test button. Changes apply at once and also show in Settings.
- **Pitch now works with the codai voice** (co-host and pets), independent of speed: the pitch slider in Settings → Voice is no longer limited to Windows voices.
- **Your head in 3D**: the skeleton now has a head that turns, nods and tilts with you (from the face model), joined to the shoulders by a neck. The F3 3D view draws it as a wireframe skull with its own axes, and shows yaw, pitch and roll. A pet sitting on your head rides forward when you bow, back when you lean back, and leans when you tilt; "in front of the face" follows where you look.

### Changed
- **Monitor → Audio has two separate switches**: **Transcript** shows your words as captions just above the controls (part of the layout, never on top of the status bar, scopes or panels; it moves down when the controls hide and steps aside while a panel is open), and **Microphone diagnostics** opens the full panel (F4). Both are saved, also in Settings → Studio; Clean feed hides them.

### Fixed
- **Moving and resizing the live captions did not work**: the controls hid themselves after 3 s of no mouse movement, which removed the handles in the middle of a drag; the strip could also be "parked" beyond the frame edge so dragging did nothing at first. The controls now stay while you hover or drag the captions, the position you drag to is exactly where the strip is shown, and the resize corner is bigger and always visible (it follows the pointer 1:1).
- **Exposure aids turned the Studio preview black**: switching on zebra, false colour, clipping or focus peaking broke the preview because the aids shader did not compile (an "infinite" false-colour band). All four aids work again.
- Empty transcription results no longer appear as "(empty transcript)" lines; they are listed only in the diagnostic log.

## [0.5.1] — 2026-10-07

### Added
- **Microphone & transcription panel** in the Studio (F4, preview only): live microphone level against the speech threshold and noise floor, clipping, your words as you speak, the last lines understood, connection state, the device, how long each sentence took to come back as text, and a plain-language hint when something is wrong (too quiet, too loud, noisy, push-to-talk, offline, no text coming back).

### Fixed
- Microphone transcription returned no text: the transcription session is now configured when it opens, sentences the server already finished are no longer sent twice, and very short sounds no longer cause "buffer too small" errors.
- Pets now notice when you call them by name in Romanian forms like "Vulpițo" or "papagalule".

## [0.5.0] — 2026-10-07

### Added
- **Pets are AI characters now**: every pet is its own continuous AI agent with its own memory and conversation. They all follow the same stream (chat, what you say, what the co-host says and what the other pets say), answer each other and the viewers by name, and remember what they said a minute ago and in earlier streams. No ready-made phrases: when a pet has nothing fresh to say, it stays quiet.
- **Fair turn-taking**: TikSee decides who talks, so pets never talk over you, the co-host or each other, the most concerned pet speaks first (its name in the chat, being picked up, a big gift), a busy chat makes them quieter, and two pets never get stuck chatting only with each other.
- **Pets remember**: a pet can keep something worth remembering (a viewer who always cheers, a running joke), and after each stream every pet that took part looks back and keeps up to three memories. Settings → Studio → Pet brain → Reflect after the stream.
- **A voice for each pet**: with "Speak pet lines" on, choose Alina, Emil or the co-host voice per pet; only the pet that talks moves its mouth.

### Changed
- Pets react to your speech and to being handled within about a second (they used to wait up to 5 seconds).

### Fixed
- The 🤟 gesture now really makes the pets dance (their own mood no longer cancels the dance after a moment).
- Speech bubbles near the edge of the frame slide inside it at full size, with the tail still pointing at the pet, instead of shrinking.
- The thresholds learned in Hands & gestures calibration are now actually used for fist, point, thumb up and victory.

## [0.4.0] — 2026-10-06

### Added
- **Instant clips**: the Studio keeps the last 15/30/60 seconds of what viewers see, encoded on the GPU (about 30 MB of memory at 8 Mbps × 30 s). Press Ctrl+Shift+K, add the "Save clip" studio action to a rule, or press Highlight to save an MP4 to Videos\TikSee. Settings → Studio → Instant clips.
- **New pets**: all seven pets rebuilt as proper models (parrot, cat, dragon, drone, fox, owl, red panda) with faces, blinking eyes, lip-sync and new moves (walk, hop, wave).
- **Pets live in 3D around you**: they perch on your shoulders, head or a raised hand, fly around your head (passing behind you) and hop between spots; they wave back when you wave, hop to a heart and go where you point. When you leave the frame they wait at the bottom edge instead of vanishing.
- **3D debug view** (F3 in the Studio): your skeleton in metres, the floor, your shoulder height and where every pet is heading. Preview only.
- **Smart pets**: each pet has its own needs, mood and personality and decides for itself what to do (perch, land on your open palm, listen to the co-host, play with the other pet, doze off when the stream is quiet, celebrate big gifts). Pets never pass through you or each other, take turns reacting, and move with breathing, springy tails and ears, gaze jumps and landing squash. Optional AI director nudges them from the chat mood (off by default).
- **3D space calibration** (Studio → Camera → Calibrate 3D space): camera model and lens, your height, stand up and sit down for a few seconds; optional precise lens calibration with a printed board and a one-time scene analysis. Pets and effects are then sized correctly for your room.
- **Touch the pets with your hands**: pinch right on a pet to pick it up and move it; bring the hand towards the camera to make it bigger or away to make it smaller, or pinch with the other hand too and spread or close your hands (the size is kept, the pet goes back to doing its own thing when you let go). Only a fresh pinch on the pet picks it up, so resting hands never drag pets away.
- **Talking pets**: pets say short things in speech bubbles that viewers see in the video, comment on what you do and on the chat, and can optionally speak (off by default, never in Shop mode). Studio dock → AI: AI level (Off / Local / Reactive / Chatty / Director), how much chat they read (None / Activity / Mentions / Full), bubbles, voice and an hourly call cap. At Director level the AI can also move pets around you.
- **Pets grow a personality**: each pet has its own traits and memories (big gifts, being picked up, regular viewers) that change slowly over streams and are kept until you reset them (Studio dock → AI → hold to reset).
- **Gesture calibration** (Calibrate 3D space → Hands & gestures): one gesture at a time at your own pace (Record, retry, Next); relaxed hand, open palm and pinch are the ones the pets need, the rest can be skipped; TikSee learns your pinch and your palm size.
- **Camera mount**: tell TikSee how high your camera is and how much it looks down (or let it estimate the tilt), so the 3D space matches your room. Settings → Studio.

### Changed
- Pets, AR objects and effects share one real 3D space (perspective, metres), so sizes and in-front/behind are consistent.
- The Studio renders at 60 fps by default (the camera rate) instead of the monitor refresh, using much less GPU; Settings → Studio → Preview frame rate.

### Fixed
- Pets no longer flicker, jump between positions or disappear when your shoulders leave the frame.
- The body skeleton moves smoothly (about 40× less jitter) and pets keep their size when you turn or move your arms.
- Gestures: hands of other people no longer trigger your gestures, left/right no longer swap, hands partly out of the frame no longer fire false gestures, OK and pinch are told apart, swipes and waves survive a dropped frame, and hand points are smoothed.
- Re-running the face calibration no longer resets other calibration values.
- Pets were drawn about 3x too big with a camera mounted sideways (portrait): the field of view now follows the rotation and the camera preset, and arms reaching towards the camera get their real depth, so pets sit on your shoulders, head and open palm at their real size.
- Pet speech bubbles stay inside the video: near an edge they shrink (down to about half size) and slide in, and they keep following the pet.
- Hands: the hand skeleton moves fluidly and stays attached to your arm (no lag behind the body), hands are tracked at twice the resolution, a pinch is no longer mistaken for pointing (or an open palm for a pinch), and pets now land on your open palm and stay there.
- A pet sent to where you pointed no longer stays there forever.

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
