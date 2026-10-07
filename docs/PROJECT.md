# TikSee — Canonical Project Document

> **Single source of truth.** Every feature, goal, story, decision, answered
> question and status lives here or in `docs/backlog.csv`. Nothing else.
>
> Last updated: 2026-10-05

---

## 1. What this is

**TikSee** is a TikTok LIVE streamer companion. It ingests a creator's live
chat (chat / gifts / follows / joins / likes / shares), renders it beautifully,
reads it aloud with an AI voice co-host, mirrors it to an external USB LCD
panel, and exposes it as an OBS browser source.

It exists on two surfaces:

| Surface | Path | Stack | Status |
| --- | --- | --- | --- |
| **Windows desktop** | `apps/desktop` | Tauri 2 + React 19 + Vite + Tailwind v4 | primary, new |
| **Android** | `apps/android` | Kotlin + Jetpack Compose | existing, ported *from* |

The Android app is the origin of the product. The desktop app is a superset.

---

## 2. Architecture

```
selfie-screen/                      (repo root — pnpm + Turborepo)
├─ apps/
│  ├─ android/                      Kotlin/Gradle app (moved from repo root)
│  ├─ desktop/                      Tauri 2 shell + React UI
│  │  ├─ src/                       React 19 renderer
│  │  └─ src-tauri/                 Rust shell
│  └─ sidecar/                      Node service: TikTok ingest + panel + WS bridge
├─ packages/
│  ├─ core/                         domain types, aggregator, protocol (pure TS)
│  ├─ ui/                           design system: theme, primitives, components
│  └─ config/                       shared tsconfig / eslint
└─ docs/
   ├─ PROJECT.md                    ← this file
   └─ backlog.csv                   ← the canonical spreadsheet
```

### 2.1 Why a Node sidecar

`tiktok-live-connector` is a Node library (WebSocket + protobuf + request
signing). It cannot run inside a WebView. Tauri's Rust core spawns it as an
`externalBin` sidecar; the renderer subscribes to a local WebSocket.

This also dissolves the hardest constraint inherited from Android — see §3.1.

### 2.2 Data flow

```
TikTok Webcast  ──ws──▶  sidecar (Node)
                            │  normalize → ChatEvent
                            ├──ws──▶  desktop renderer (React)
                            ├──ws──▶  OBS browser source  (http://127.0.0.1:PORT/overlay)
                            ├──serial──▶ Turing LCD panel (COM6)
                            └──sqlite──▶ history / analytics
```

---

## 3. Key technical findings

### 3.1 The synchronous-ACK constraint was an Android artifact

Android ingests chat by loading `tiktok.com/@user/live` in a hidden `WebView`,
monkey-patching `window.WebSocket`, and passing each binary protobuf frame to
Kotlin through a **synchronous** JS bridge whose return value is the ACK bytes.
TikTok stops pushing after ~3 unacknowledged frames, so the round-trip had to
be synchronous.

**That requirement only exists because native code doesn't own the socket.**
When a Node process owns the socket, the ACK is a local `ws.send()`. Moving
ingestion into the sidecar removes the constraint entirely — and with it the
entire WebView-sniffing subsystem.

The sniffer survives as an interface-compatible **fallback driver**, rewritten
so the ACK is built *in-page* (never crossing a process boundary), which is
strictly better than the Android original.

### 3.2 Turing panel on Windows

The panel (`VID_1A86 / PID_CA21`, "CT21INCH") enumerates on Android as a raw
USB bulk device but on **Windows as a serial port — verified at `COM6`**. The
6-byte command protocol and RGB565 framebuffer format are unchanged; only the
transport differs (`serialport` instead of USB bulk transfer).

**Verification status (2026-08-12):** detection is VERIFIED — the self-test
enumerates `COM6 vid=1A86 pid=CA21 <-- TURING PANEL`. Opening it fails with
`Access denied` because **`AorusLcdService` (Gigabyte LCD software) holds the
port exclusively**; a serial port has exactly one owner. A 30s hot-plug watch
recorded no add/remove event, so it is unconfirmed whether COM6 is the Turing
panel or a Gigabyte panel using the same CH340-class chip.

Frame push is therefore **code-complete but unverified on hardware**
(backlog WS13-06). To verify: stop `AorusLcdService`, then
`pnpm --filter @tiksee/sidecar panel:test`. The app surfaces the conflict as a
readable "port busy" error rather than failing silently.

### 3.3 Stack decisions

- **No Next.js.** No server, no RSC benefit, `next-intl` is Next-only. Vite +
  TanStack Router instead.
- **Theming is 3 orthogonal axes** (`mode` × `accent` × `surface`) on `<html>`,
  never combined into one class. Accent stored as OKLCH *channels* so a custom
  color picker is two numbers, not eleven hex values.
- **`tiktok-live-connector` is AGPL-3.0.** Accepted: this project may be
  open-sourced under an AGPL-compatible license.

---

## 4. Decisions log (answers to questions asked)

| # | Question | Decision | Date |
| --- | --- | --- | --- |
| Q1 | Monorepo scope | **Full monorepo** — move Android to `apps/android`, add `apps/desktop` + `packages/*` | 2026-08-12 |
| Q2 | Desktop shell | **Tauri 2 + Node sidecar** (agent's call after research) | 2026-08-12 |
| Q3 | Feature scope | All core features + panel + OBS + SQLite + analytics + moderation + giveaway + alerts + palette | 2026-08-12 |
| Q4 | Azure credentials | Same endpoint; key in **Windows Credential Manager**, entered in Settings | 2026-08-12 |
| Q5 | Android changes | **Full backport** of theme system + RO/EN i18n | 2026-08-12 |
| Q6 | Ingestion strategy | **`tiktok-live-connector` primary + sniffer fallback** behind an interface | 2026-08-12 |
| Q7 | AGPL | May open-source later under AGPL-compatible terms — **acceptable** | 2026-08-12 |
| Q8 | USB panel | **Connected to this PC** → build and verify empirically | 2026-08-12 |
| Q9 | Tracking docs | `docs/PROJECT.md` + `docs/backlog.csv` | 2026-08-12 |
| Q10 | Extra features | number-flow, resizable panels, updater, Sentry, SAPI fallback, gift $ tracking, replay, OBS control, multi-stream, chat search, autostart+tray, Stream Deck | 2026-08-12 |
| Q11 | App name | **TikSee** | 2026-08-12 |
| Q12 | Video path | **LIVE Studio Link/browser source overlay first**; then full capture in TikSee (filters + pets) → OBS Virtual Camera; then native Win11 virtual camera | 2026-10-05 |
| Q13 | Pets renderer | **3D**: Blender 5.1 scripted pipeline → glTF (meshopt+KTX2) → three.js WebGPURenderer + R3F; shared rigs per family + shared animation library + state machine | 2026-10-05 |
| Q14 | First pets | parrot, cat, dragon, codai drone (mascot), fox, owl, red panda | 2026-10-05 |
| Q15 | GPU | **Local RTX 3060 Ti** (WebGPU), live encode on NVENC; cloud GPU only if measured insufficient | 2026-10-05 |
| Q16 | STT | codai `codai-transcribe-live` (Azure, works today) with language hint; **Deepgram Nova-3 `ro` lane env-gated**, enabled when the owner creates an account | 2026-10-05 |
| Q17 | TTS | Azure Speech ro-RO (Alina/Emil) via a new codai lane `codai-tts-ro` with viseme + word events; new Azure Speech S0 in westeurope | 2026-10-05 |
| Q18 | Co-host brain | New npm package **`codai-live-agent`** in the codai repo (tsdown, SemVer), consumed by the sidecar | 2026-10-05 |
| Q19 | Reply policy | Deterministic score + token bucket ≈4/min + never over the streamer + approvable queue | 2026-10-05 |
| Q20 | Post to TikTok chat | **No** — voice + on-screen bubble only | 2026-10-05 |
| Q21 | Smart home | vmui MCP; viewers may trigger small effects with `!commands` (60 s per user, 3 s global); gift tiers trigger big effects; whitelist + kill switch | 2026-10-05 |
| Q22 | Stack | Everything to latest stable (pnpm 12, Node 24, TS 7 dual install, Vitest 5, tsdown, React 19.3, Tauri 2.12, Rust 2024, Motion 14) | 2026-10-05 |
| Q23 | Android | Build upgrade only, no new features | 2026-10-05 |
| Q24 | codai key | Dedicated unrestricted `tiksee` key; usage + latency measured per lane | 2026-10-05 |
| Q25 | Studio assistant | Returning-viewer card, teleprompter, goals, post-live summary, highlights, spike detection, chat games, live translation — all in | 2026-10-05 |
| Q26 | Viewer memory | SQLite in the sidecar via `node:sqlite` (no native module); optional summary sync to codai memory | 2026-10-05 |
| Q27 | TTS audio out | Selectable output device, default a Voicemeeter strip; ducking while the streamer speaks | 2026-10-05 |
| Q28 | Persona | "Codai", drone mascot, Romanian default, answers in the viewer's language, max 2 sentences, editable | 2026-10-05 |
| Q29 | Distribution | Owner only: NSIS + signed updater from public GCS bucket `tiksee-releases`; Node bundled | 2026-10-05 |
| Q30 | System One | Use it for async enrichment **and** improve it in codai (batch `items[]`, per-request timeout, opt-in fallback, SDK helper) | 2026-10-05 |
| Q31 | Live Control | Always-visible bar: mute, pause replies, skip, effects off, Shop LIVE mode (no AI voice), hide pets — on hotkeys + Stream Deck | 2026-10-05 |
| Q32 | Delivery order | P0 live-ready → P1 codai brain → P2 vmui effects → P3 3D pets → P4 capture + filters → P5 native virtual camera | 2026-10-05 |
| Q33 | Pets render path | Composite camera + pets + filters inside TikSee (pose and render on the same frame) → OBS window capture / virtual camera; browser overlay on WebGL2 only as fallback (OBS CEF 127 / LIVE Studio Chromium 136 have no reliable WebGPU) | 2026-10-05 |
| Q34 | Texture compression | KTX-Software 4.4.2 (KTX2/Basis) installed per-user | 2026-10-05 |
| Q42 | Camera control | Sony ZV-E10 controlled from Studio; USB PTP was the intended default, BLE remote in parallel for zoom/focus | 2026-10-05 |
| Q43 | Camera control while live | **Bluetooth remote is the live transport.** Measured: Sony SDIO `GetExtDeviceInfo` (0x9202) over USB blanks the camera's HDMI output for as long as the session is open (luma 40 → 7, reproduced 3×; plain PTP session does not). USB PC Remote stays opt-in (`TIKSEE_CAMERA_CTL=usb`) for setting ISO/WB/shutter before going live | 2026-10-05 |
| Q44 | Native virtual camera | `MFCreateVirtualCamera` **System lifetime, AllUsers**: the installer (elevated, perMachine) registers `tiksee_vcam.dll` (Rust media source, Frame Server) + creates "TikSee Camera"; the camera shows an offline frame when TikSee is closed. App → DLL over the `Global\TikSeeVcam` NV12 ring; frames converted RGBA→NV12 by a WebGPU compute pass and sent as raw IPC (`vcam_frame`). In-app "Repair camera" re-runs `tiksee-vcam-setup.exe install` with UAC | 2026-10-05 |
| Q45 | Vision stack | All local: MediaPipe Tasks 1.0.1 (pose + masks, GestureRecognizer, FaceLandmarker with 52 blendshapes, EfficientDet-Lite0 objects) in a module worker; onnxruntime-web 1.30 (WebGPU) for optional models. Optional models (SFace int8 face 10 MB, DINOv2-S q8 dog 24 MB, Depth Anything V2 Small fp16 50 MB, all Apache-2.0) download on first enable from `tiksee-releases/models/`, sha256-pinned, cached in Cache Storage. InsightFace / DA-V2 Base+ / DepthPro rejected on licence | 2026-10-05 |
| Q46 | Identity & privacy | Only explicitly enrolled profiles (owner, named people, dogs Koro/Kara/Kiri) store embeddings, locally in SQLite; unknown people are "unknown" and never stored; delete is a hard delete. Beta in 0.3.0 | 2026-10-05 |
| Q47 | Depth / AR | Hybrid: body-scale distance (calibrated shoulder width / IPD) by default, optional Depth Anything V2 Small per-pixel map scaled to the owner's distance. Objects live at x/y/z; the person mask occludes an object when the person is nearer (±0.1 m hysteresis, 150 ms crossfade) — you walk through it by moving forward/back | 2026-10-05 |
| Q48 | Rules | One Rule tree (triggers OR → `when` condition all/any/not/compare → actions with if/else, wait, repeat, parallel, set, stop; modes single/restart/queued/parallel; cooldown). Edited in a list editor AND an xyflow node graph (graph = projection, positions in `rule.ui.graph`). Sidecar evaluates; studio-only actions are relayed as `ruleAction`. Sensitive rules need an arm (open palm 1 s → 5 s window) | 2026-10-05 |
| Q49 | Preview vs output | Two render targets: monitoring aids (peaking, zebra, false colour, clipping) only in the preview pass; guides, safe zones, AF boxes, HUD, scopes are DOM over the preview. Nothing preview-only reaches the virtual camera | 2026-10-05 |
| Q50 | Clip buffer (0.4.0) | Rolling buffer of the OUTPUT target (what viewers see, never preview aids): GPU `copyTextureToTexture` into a WebGPU OffscreenCanvas → `VideoFrame` → WebCodecs H.264 High (`prefer-hardware`, 30 fps, keyframe every 1 s, 4/8/12 Mbps) → byte-capped ring of encoded access units (RAM ≈ bitrate × window, hard cap ×1.5). No pixel readback. Save = encoder flush → MP4 mux (mediabunny 1.61.1, MPL-2.0, lazy chunk) → raw IPC `clip_save` → `Videos\TikSee\TikSee-YYYYMMDD-HHMMSS.mp4` (never overwrites). Triggers: hotkey Ctrl+Shift+K, studio action `saveClip` in rules, and every highlight when `saveOnHighlight`. Captions deferred | 2026-10-06 |
| Q51 | Pets in 3D (0.4.0) | **Models**: procedural stylised "chibi" pets built in Blender from scripts (`build-all.ps1 -Procedural`: Skin modifier + subdivision → manifold meshes, heat weights with 0 unweighted vertices, vertex colours, glossy eyes, 6-8.5k tris, 84-189 KB). Contract: Y-up, faces +Z, feet at origin, height = `heightM` metres, bones root/hips/chest/neck/head/jaw/tail*/legs/wings, morphs `mouth_*` (8 visemes) + `eyes.blink`, 10 clips (idle look talk react dance sleep fly walk hop wave, no spins, ≤120°). TRELLIS textured upgrade stays a later job. **Space**: ONE perspective camera at the origin in metres for pets, AR and effects; vFOV = `studio.vfovDeg` (60) narrowed by cover crop + digital zoom; camera backdrop is a clip-space quad. **Body**: `BodyModel` turns 10-30 Hz pose into a skeleton in metres (depth = body-scale/depth-model distance + MediaPipe z scaled by the shoulder span), sampled every render frame with a 70 ms spring + 120 ms extrapolation; per-joint confidence with hysteresis and 400 ms fades (no popping). **Roaming**: anchor graph (shoulders, crown, raised hands, orbit around the head that passes behind the owner, frame-bottom ledges, centre, point) + arrive steering; fliers fly, walkers hop between perches; with nobody tracked pets go to a ledge (never leave the frame). **Occlusion** per pixel like AR (person mask × in-front decision with 0.1 m hysteresis, or the depth map), dithered alpha so pet parts stay depth-correct. Look-at (head/neck, clamped), blinks, contact shadow, LOD (no mixer while hidden, half rate when tiny), gesture reactions (wave → wave back, heart → hop + hearts, point → go there). **3D debug overlay** (F3, preview only): skeleton in metres coloured by depth, metric floor grid + depth wall, axes, pet boxes/anchors/paths/occlusion, HUD. **Render cap** `studio.previewFps` 60 by default (camera rate). **Room frame** (owner feedback 2026-10-06: webcam on top of the monitor, seated): world = room, floor y = 0, camera at `cameraHeightM` (1.2) pitched down `cameraTiltDeg` (15) or auto from the upright neck; depth = along the optical axis; overlay floor stops in front of the owner. **Smoothing**: One-Euro per measured joint (xy 0.8 Hz/β 1.5, depth 0.4 Hz) + 120 ms spring + half-velocity 60 ms extrapolation; head look-at restored to the bind pose before every mixer update (it accumulated = endless spin) and eased over 0.35 s | 2026-10-06 |
| Q52 | Smart pets in metric 3D (0.4.0) | Research-led (owner chose all options). **Fluid skeleton**: MediaPipe numPoses 1 (built-in smoothing on), FULL model, rVFC-driven pushes stamped with camera capture time, pose result posted before the other tasks, One-Euro in image px + depth separately and ONE unprojection, fixed adaptive delay (p90 latency+interval, 50-160 ms) with cubic Hermite interpolation; replayed 30 Hz noisy pose: still jitter 6.62 → 0.16 px/frame², moving 4.17 → 0.62, lag 233 → 150 ms. **Metric distance**: whole-body root-translation solve from MediaPipe world landmarks (yaw/arm-pose invariant) + iris (11.7 mm) fused in a Kalman on log Z with 3σ gating; vFOV default 45° (ZV-E10 16 mm), camera presets + lens mm. **3D space calibration wizard** (camera, height, stand up → tilt + camera height + worldScale, sit → personal shoulder/iris/head height), optional ChArUco lens calibration (js-aruco2 MIT + own Zhang/LM, 17 KB lazy) and a one-time MoGe-2 ViT-S scene pass (MIT, 141 MB, mirrored at tiksee-releases/models, sha256 24eacb5d…) for FOV + desk/wall planes. Per-user training rejected: the errors are scale and pose bias, fixed geometrically. **Behaviour**: utility AI (IAUS) per pet at 5 Hz with needs, PAD-lite mood and species personality, momentum + boredom + cooldowns + seeded near-best choice; perch reservations; spotlight token on shared stimuli with personal echo delay; hard constraint pass (body capsules + pet-pet gap, position projection) so pets never intersect the owner or each other; optional LLM director in the sidecar (enum-only nudges with TTL, off by default). **Procedural layer**: saccadic gaze with blink on big shifts, breathing, spring tails/ears, squash/stretch, anticipation, idle micro-motion. F3 shows capsules, utility bars, needs, mood, push badge, delay and distance sources | 2026-10-06 |
| Q53 | Hands, talking pets, persistent personalities (0.4.0) | Owner chose all recommended options. **Hand depth monocular**: MediaPipe hand world landmarks (metric shape) solved against the 21 image points (same least-squares as the body), scaled by the calibrated palm width, gated against the pose wrist depth (> 0.25 m off = use wrist depth + relative finger depth). Stereo second camera deferred (WS29-17): ~3 mm vs ~3-5 cm but needs stereo ChArUco, timestamp sync, +4-6 ms GPU. **Pinch** = min(world thumb-index / palm width, image thumb-index / hand size) with an image veto (live 2026-10-06: world reads 0.6-1.2 on a real side-on pinch, image 0.11-0.17, pointing 1.1+; world alone also read flat open palms as pinches), median of 3, 200 ms release, hysteresis on 0.35 / off 0.55 (uncalibrated profiles reset to these), point frozen 50 ms at onset, One-Euro. **Grab** (revised live 2026-10-06: monocular hand depth is 0.2-0.4 m off, a 3D sphere never hit): picked ON SCREEN within the pet's body (0.55 x height at the pet's depth, depth gate 0.6 m) by a pinch that started <= 700 ms ago and held 50 ms; held pet keeps its pick-up depth and follows the fingers on screen; one-hand push/pull scales it by the hand's apparent size (5 % dead band); second-hand pinch = resize by on-screen hand spread (floor 0.15 frame heights, 0.4-2.5); dropouts < 120 ms keep it. Hand skeleton: results interpolated per render frame and translated onto the body's interpolated wrist; vision input 1280 px long edge (hand was 35 px tall at 640), scale persisted per pet in studio.petHands, position returns to the mind on release. **Gesture fixes**: side from the matched pose wrist, stranger hands rejected (> 0.6 shoulder widths from any wrist), stale hands only on stagger frames, One-Euro on hand points, 150 ms grace, off-frame gating, ok vs pinch by middle finger. **Calibration**: wizard step, one gesture at a time (2 s record, retry, Next/Previous, Skip for optional ones; relaxed + open palm + pinch required for the pets; no forced verify pass, owner feedback 2026-10-06), saved in vision.calibration.hands. **AI levels** (studio.petAi.level): off / local (utility AI, no LLM) / reactive (LLM on gift, follow, mention, interaction) / chatty (+ routine comments + chatter action) / director (+ validated anchor/clip commands). **Chat awareness** separate: none / activity (counts only) / mentions / full (8 moderated lines); chat is a JSON data field, never instructions; output moderated + enum-validated. One codai-fast call for all pets, token bucket per level capped by maxCallsPerHour. **Bubbles in the video**: CanvasTexture billboard in the WebGPU scene (troika/three-mesh-ui are GLSL-only), spring pop, typewriter 35 cps, morph between lines, constant on-screen size. Voice optional through CoHost.speak (same gate, never Shop mode). **Personality**: OCEAN traits + learned likes + up to 40 memories per pet in sidecar SQLite (pet_personality, migration 4); drift computed in code (<= 0.02 traits / 0.05 likes per session), the LLM only reads it; reset per pet (hold) in the dock AI panel | 2026-10-06 |
| Q54 | Pets as continuous AI agents (0.5.0) | Owner asked 2026-10-07 for each pet to be its own continuous agent (own session, sees the other pets and the conversation, no predefined lines); chose all recommended options after research (Generative Agents memory/reflection, Letta sleep-time, AutoGen rule-based speaker selection, MAST failure taxonomy, Lyfe fast/slow cost split, spotlighting for prompt injection). **One agent per pet** (`apps/sidecar/src/pets`): fixed persona card (species, trait words, code-written bio; the model never rewrites it), long-term memories, its own resumable turns (`pet_turns`, migration 5, last 6 in the prompt), prompt ordered stable-first for the gateway cache. **Shared blackboard** (`StreamLog`, 2 min window + counts digest): chat (sanitised, quoted with «», per chat awareness), gifts/follows, streamer transcript, co-host utterances, every pet's line, owner actions and vision observations; viewer facts only for the viewer behind the trigger. **Deterministic floor control** (`Floor`): events add salience pressure to the concerned pets (30 s half-life), a pet speaks when pressure crosses the level threshold, its 12 s cooldown and the global 6-20 s gap (longer when the chat is busy) passed, nobody is voiced, the streamer has been quiet 1.8 s and the hourly budget allows; the last speaker is damped unless addressed; pet-to-pet exchanges stop after 2 turns without outside input. Only the chosen pet's agent is called (codai fast, streamed, 160 tokens, 5 s); reply JSON = say/emotion/remember/move, zod-validated, cleaned, blocked-word moderated, dropped when similar (Jaccard >= 0.6) to a recent pet line or when someone started talking meanwhile; silence is a valid answer (no canned fallback lines). Memory written by the agent (`remember`, moderated, de-duplicated); after each stream one reflection call per pet that spoke >= 3 times keeps <= 3 memories (setting `petAi.reflection`). Voice: optional, per-pet TTS voice (`petAi.voices`) through the co-host queue (same gate), `petSay.sayId` = queue entry so only that pet lip-syncs. The renderer reports a pet's wish to talk at once (`petTalk`, 1 s) instead of on the 5 s petState. Replaces PetVoice (one batched call) and PetDirector (separate nudge call). | 2026-10-07 |


## 5. Theme system

Three independent attributes on `<html>`:

```html
<html class="dark" data-accent="violet" data-surface="mica">
```

| Axis | Values |
| --- | --- |
| **mode** | `light` · `dark` · `system` |
| **accent** | `cyan` (default, matches Android) · `violet` · `amber` · `emerald` · `rose` · `sky` · custom (OKLCH picker) |
| **surface** | `solid` · `glass` (acrylic) · `mica` · `contrast` (high contrast) |

Accent is stored as OKLCH channels (`--accent-h`, `--accent-c`) and the full
ramp is synthesized with `oklch()` + `color-mix()`.

**Locale**: `ro` · `en` · `system`, via `i18next` + `react-i18next`.

The Android app mirrors all four axes (§ backlog WS-12).

---

## 6. Design language (inherited from Android, extended)

| Token | Android value | Desktop treatment |
| --- | --- | --- |
| Accent (CHAT) | `#62D6FF` cyan | default accent preset |
| AccentWarm (GIFT) | `#FFB454` amber | semantic `--kind-gift` |
| Ok (FOLLOW) | `#4ADE80` green | semantic `--kind-follow` |
| Violet (JOIN) | `#A78BFA` | semantic `--kind-join` |
| Err (LIKE) | `#F87171` | semantic `--kind-like` |
| Sky (SHARE) | `#38BDF8` | semantic `--kind-share` |
| Card radius | 20dp | `--radius-card` |
| Chip radius | 12dp | `--radius-chip` |
| Card padding | 18dp | `--space-card` |

Motion: 120–320ms, `FastOutSlowInEasing` ≈ `cubic-bezier(0.4, 0, 0.2, 1)`.
All animation respects `prefers-reduced-motion`.

---

## 7. Status

See `docs/backlog.csv` for the authoritative per-item status.

| Workstream | Status |
| --- | --- |
| WS-00 Docs & tracking | done |
| WS-01 Monorepo | done |
| WS-02 packages/core | done |
| WS-03 Sidecar | done |
| WS-04 Tauri shell | done |
| WS-05 packages/ui theme | done |
| WS-06 Desktop UI | done |
| WS-07 Overlay + OBS | done |
| WS-08 Voice | deferred — Azure wiring ported, not exercised on Windows |
| WS-09 Panel | serial transport verified; live render deferred |
| WS-10 Data & analytics | done |
| WS-11 i18n | done |
| WS-12 Android backport | deferred — Android app moved to `apps/android`, untouched |
| WS-13 Verification | done |

### 7.1 Verification evidence

All claims below were observed, not inferred.

| Claim | Evidence |
| --- | --- |
| Monorepo builds green | `pnpm verify` → 14/14 turbo tasks, 73 tests passing |
| App launches | `tiksee.exe` window "TikSee", screenshot captured |
| All four routes render | Live / People / Analytics / Settings screenshots |
| Chat pipeline works | 90-event replay at 6× → feed, gift cards, REPLAY badges |
| Stats aggregate live | 91 events, 6 viewers, 4 530 diamonds, $22.65 in header |
| People ranking works | 6 viewers ranked by diamonds with VIP/Top/New badges |
| Charts render | activity area, event-mix donut, top-gifter bars with real data |
| Theme switching | light/dark + violet accent applied across the whole UI |
| Native frame follows theme | `set_theme` + mica reapplied; light title bar verified |
| Settings persist | `%APPDATA%\ro.codai.tiksee\settings.json` mtime advances on change |
| RO locale | full UI translated (Aspect, Culoare accent, Confidențialitate) |
| OBS browser source | HTTP 200 standalone HTML + WS config/event frames in 6 s |
| Turing panel present | COM6 `VID_1A86 PID_CA21`, 307 200-byte frame pushed |
| Code splitting | charts in a separate 406 KB chunk, not in the entry bundle |

---

## 8. Open questions

- Deepgram account: owner may create one later; the lane ships env-gated (Q16).

---

## 10. Live studio (2026-10 plan)

### 10.1 Audit findings (2026-10-05)

A reality check found twelve backlog rows marked Done that were not (sniffer,
hotkeys, updater, TikTok session, notifications, multi-stream, SQLite, viewer
memory, export, OBS rules, Stream Deck, panel on hardware). They are corrected
in `backlog.csv`. Other blockers: the installer did not ship the sidecar, the
sidecar needed a system Node, no CI, ~20 settings stored but never read.

### 10.2 Target architecture

```
mic ─► sidecar ─ws─► codai /v1/realtime (codai-transcribe-live, lang=ro) ─► transcript
TikTok ─► sidecar ingest ─► scorer (deterministic, <5 ms) ─► token bucket ─► queue (UI approve/skip)
                               │                                      │
                               └─► System One (async, batch, 800 ms) ─┤
                                                                      ▼
                         codai-live-agent: triage ∥ moderation ∥ responder (codai-fast, streamed)
                                                                      ▼
                     sentence chunker ─► codai-tts-ro (audio + visemes) ─► output device (Voicemeeter)
                                                                      ▼
                     pets (three WebGPU, lip-sync) + speech bubble ─► overlay / composite
gifts / !commands ─► effect limiter ─► vmui MCP (scene_set, flash_color) ─► Home Assistant
viewer memory: node:sqlite in sidecar (people, sessions, events, facts)
```

Reusable parts live in codai: `codai-live-agent` (npm), SDK realtime client,
`codai-tts-ro`, the `live` ephemeral scope and System One batching.
Smart-home parts live in vmui's MCP catalogue.

### 10.3 Phases

| Phase | Scope | Backlog |
| --- | --- | --- |
| P0 | Live-ready: bugs, stack upgrade, sidecar exe, updater, gates/CI, read chat aloud, Live Control | WS15, WS16, WS17, WS18, WS22 |
| P1 | codai brain: STT, triage, replies, queue, viewer memory, studio assistant | WS19, WS20 |
| P2 | vmui effects and chat commands | WS21 |
| P3 | 3D pets | WS23 |
| P4 | Capture + beauty filters + composite | WS24 |
| P5 | Native virtual camera | WS25 |

### 10.4 Status (2026-10-06)

| Phase | State | Evidence |
| --- | --- | --- |
| P0 | done | 0.3.0 published 2026-10-06 from clean tree 60d349b (`latest.json` 0.3.0, signed; installer HTTP 200, 69591679 bytes); 0.2.0 before it; installer bundles Node |
| P1 | done | WS20-08/10/13/14 shipped in e04c976; WS19-06 codai-live-agent in codai 5b32d8c + public mirror v0.1.0 (npm first publish pending owner login) |
| P2 | done | Test flash from TikSee → vmui audit `mcp.flash_color cyan ok` |
| P3 | pipeline + runtime done, real meshes blocked | Blender pipeline verified on proxy rigs; TRELLIS.2 waits on Meta DINOv3 access (VM `tiksee-trellis` stopped) |
| P4 | composite running | Studio window 1080×1920 WebGPU: camera 59–60 fps, render 130–180 fps; camera rotation; auto-reopen after 3 s without frames |
| Camera remote | BLE done | Paired PC ↔ ZV-E10 over WinRT; zoom tele/wide confirmed by owner with HDMI picture intact; Studio settings card (hold-to-zoom/focus, AF, photo, record) |
| P5 | done | "TikSee Camera" registered System-wide; ffmpeg dshow reads NV12 + YUY2 1080×1920 correctly; studio pump 60 fps, 0 dropped (loopback WebSocket, readback 4.6 ms); listed in TikTok LIVE Studio |
| Vision (WS27) | done (identity beta) | Worker: pose 6 / hands 5 / face 3.5 / objects 24 ms, total ~18 ms; studio render 180 fps p95 5.7 ms; 109 vision tests, 34 rules tests |
| Studio pro (WS28) | done | Owner confirmed: overlays fluid, BLE zoom from Studio, aspect lock, responsive controls, rounded main UI |
| Clip buffer (WS28-07, 0.4.0) | done (unreleased) | Q50; live dev app 1080×1920, 90 log samples each: render **177.1 → 178.5 fps median, p95 5.70 → 5.70 ms**; clip encoder 30 fps, capture 0.1 ms CPU/frame, 30.7 s / 14 MB buffered. Highlight button saved `TikSee-20261006-044804.mp4`: h264 High 1080×1920 30 fps, 912 frames, 30.55 s, 12.4 MB, full ffmpeg decode clean. Default hotkey Ctrl+Shift+K (Ctrl+Alt+C was taken on this PC, RegisterHotKey 1409) |

---

## 9. Hardening pass (post-review)

A deep review of the first working build found real gaps beyond the two
reported bugs. All of them are fixed and verified.

### 9.1 Correctness

| Gap | Fix |
| --- | --- |
| Duplicate `client attached` on every reload — the WS effect re-ran because its deps changed identity | Effect made dependency-stable; a module-level singleton guards double-connect under React StrictMode + HMR |
| `unlisten` crash on teardown (`Cannot read properties of undefined`) | Teardown captures the resolved handle and no-ops if the listener never resolved |
| `CommandPalette` infinite render loop (`getSnapshot should be cached`) | Selector returns a stable reference instead of a fresh array each call |
| Autostart error on launch (`The system cannot find the file specified`) | Autostart is now gated to packaged builds and failures degrade to a warning, never a toast |
| Sidecar path broke under UNC-prefixed paths (`EISDIR: lstat 'E:'`) | Sidecar resolution strips the `\\?\` prefix before spawning Node |
| Replay could double-start and interleave two sessions | Replay is single-flight; starting again cancels the in-flight run first |
| Panel writer could overlap frames on a slow COM port | Frame pushes are serialized behind a write lock; late frames coalesce |

### 9.2 Robustness

- Sidecar port is negotiated dynamically and reported to the shell, so a stale
  process never wedges startup.
- The connector reconnects with capped exponential backoff and surfaces state
  transitions to the UI instead of failing silently.
- OBS browser-source clients are tracked and receive a full config snapshot on
  attach, so a source added mid-stream renders immediately.
- Every long-lived stream has an explicit teardown path; no orphaned listeners
  survive a disconnect.

### 9.3 Verification after hardening

| Claim | Evidence |
| --- | --- |
| Whole monorepo green | `pnpm verify` → 14/14 turbo tasks, all tests passing |
| No console errors on launch | dev log clean: sidecar ready → client attached (1), nothing else |
| Single WS client per reload | `client attached (1)` exactly once per page load |
| No autostart failure | launch log has no autostart error line |
| Clean shutdown | app exits without orphaned `tiksee.exe` or project `node.exe` |

Only remaining lint output is one intentional warning: React Compiler skips
memoizing `chat-feed.tsx` because TanStack Virtual's `useVirtualizer()` returns
non-memoizable functions. That is expected and documented upstream.
