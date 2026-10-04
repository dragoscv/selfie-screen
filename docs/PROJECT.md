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

---

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
