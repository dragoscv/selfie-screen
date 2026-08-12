# TikSee — Canonical Project Document

> **Single source of truth.** Every feature, goal, story, decision, answered
> question and status lives here or in `docs/backlog.csv`. Nothing else.
>
> Last updated: 2026-08-12

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

_None currently. All blocking questions answered — see §4._
