/**
 * The OBS browser-source page.
 *
 * Deliberately a single self-contained string with no build step, no imports
 * and no framework: OBS's embedded CEF loads it directly, it must survive a
 * scene switch instantly, and a broken bundle would take a live stream's
 * overlay down. Vanilla JS + CSS keeps that risk at zero.
 */
export const OVERLAY_HTML = String.raw`<!doctype html>
<html lang="en" data-mode="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TikSee overlay</title>
<style>
  @layer base, layout, motion;

  @layer base {
    :root {
      --accent-h: 200; --accent-c: 0.14;
      --accent: oklch(0.78 var(--accent-c) var(--accent-h));
      --kind-chat:   #62D6FF;
      --kind-gift:   #FFB454;
      --kind-follow: #4ADE80;
      --kind-join:   #A78BFA;
      --kind-like:   #F87171;
      --kind-share:  #38BDF8;
      --row-bg: color-mix(in oklab, #0B0E14 72%, transparent);
      --row-fg: #E8ECF6;
      --row-dim: #96A0B5;
      --radius: 14px;
      --gap: 8px;
      color-scheme: dark;
    }
    html[data-mode="light"] {
      --row-bg: color-mix(in oklab, #FFFFFF 82%, transparent);
      --row-fg: #10131A;
      --row-dim: #5A6377;
      color-scheme: light;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: transparent;
      font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
      /* OBS composites this over video; never paint an opaque page background. */
      overflow: hidden;
    }
    body.opaque { background: #0B0E14; }
  }

  @layer layout {
    #feed {
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: var(--gap);
      height: 100%;
      padding: 14px;
    }
    .row {
      display: grid;
      grid-template-columns: 3px auto 1fr auto;
      align-items: start;
      gap: 10px;
      padding: 9px 12px;
      border-radius: var(--radius);
      background: var(--row-bg);
      backdrop-filter: blur(14px) saturate(1.25);
      box-shadow: 0 6px 22px rgb(0 0 0 / 0.28);
      color: var(--row-fg);
    }
    .rail { align-self: stretch; border-radius: 2px; background: var(--kind); min-height: 20px; }
    .avatar {
      width: 30px; height: 30px; border-radius: 50%;
      object-fit: cover; background: color-mix(in oklab, var(--kind) 26%, transparent);
      display: grid; place-items: center;
      font-size: 13px; font-weight: 700; color: var(--kind);
    }
    .body { min-width: 0; }
    .name {
      font-size: 12.5px; font-weight: 700; color: var(--kind);
      letter-spacing: 0.01em; line-height: 1.25;
    }
    .text {
      font-size: 14px; line-height: 1.35; word-break: break-word;
      overflow-wrap: anywhere; display: -webkit-box;
      -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
    }
    .time { font-size: 10px; color: var(--row-dim); font-variant-numeric: tabular-nums; }

    /* --- bubbles --- */
    html[data-layout="bubbles"] .row {
      grid-template-columns: auto 1fr;
      border-radius: 20px;
      background: color-mix(in oklab, var(--kind) 16%, var(--row-bg));
      border: 1px solid color-mix(in oklab, var(--kind) 40%, transparent);
    }
    html[data-layout="bubbles"] .rail,
    html[data-layout="bubbles"] .time { display: none; }

    /* --- ticker: one line, horizontal --- */
    html[data-layout="ticker"] #feed { flex-direction: row; align-items: flex-end; overflow: hidden; }
    html[data-layout="ticker"] .row { flex: 0 0 auto; max-width: 30ch; }
    html[data-layout="ticker"] .text { -webkit-line-clamp: 1; }

    /* --- minimal: text only --- */
    html[data-layout="minimal"] .row {
      background: transparent; backdrop-filter: none; box-shadow: none;
      padding: 2px 0; grid-template-columns: 1fr;
      text-shadow: 0 2px 6px rgb(0 0 0 / 0.85);
    }
    html[data-layout="minimal"] .rail,
    html[data-layout="minimal"] .avatar,
    html[data-layout="minimal"] .time { display: none; }
    html[data-layout="minimal"] .name { display: inline; margin-right: 6px; }
    html[data-layout="minimal"] .text { display: inline; }
  }

  @layer motion {
    @keyframes enter {
      from { opacity: 0; transform: translate3d(-14px, 6px, 0) scale(0.97); }
      to   { opacity: 1; transform: none; }
    }
    @keyframes leave { to { opacity: 0; transform: translate3d(0, -8px, 0); } }
    .row { animation: enter 260ms cubic-bezier(0.16, 1, 0.3, 1) both; }
    .row.leaving { animation: leave 200ms ease-in forwards; }
    html[data-reduced-motion="true"] .row,
    html[data-reduced-motion="true"] .row.leaving { animation: none; }
    @media (prefers-reduced-motion: reduce) {
      .row, .row.leaving { animation: none; }
    }
  }
</style>
</head>
<body>
<div id="feed" role="log" aria-live="polite" aria-label="Live chat"></div>
<script>
(() => {
  "use strict";
  const feed = document.getElementById("feed");
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);

  const ACCENTS = {
    cyan:    [200, 0.14], violet: [292, 0.17], amber: [70, 0.15],
    emerald: [160, 0.13], rose:   [12,  0.16], sky:   [232, 0.15],
  };

  let config = {
    layout: params.get("layout") || "stack",
    maxRows: Number(params.get("rows")) || 8,
    rowTtlMs: Number(params.get("ttl")) || 0,
    showAvatars: params.get("avatars") !== "0",
    showTimestamps: params.get("time") !== "0",
    transparent: params.get("opaque") !== "1",
    mode: params.get("mode") === "light" ? "light" : "dark",
    accent: params.get("accent") || "cyan",
    reducedMotion: params.get("motion") === "0",
  };

  function applyConfig() {
    root.dataset.layout = config.layout;
    root.dataset.mode = config.mode;
    root.dataset.reducedMotion = String(!!config.reducedMotion);
    document.body.classList.toggle("opaque", !config.transparent);
    const preset = ACCENTS[config.accent] || ACCENTS.cyan;
    const hue = Number.isFinite(config.customAccentHue) ? config.customAccentHue : preset[0];
    const chroma = Number.isFinite(config.customAccentChroma) ? config.customAccentChroma : preset[1];
    root.style.setProperty("--accent-h", String(hue));
    root.style.setProperty("--accent-c", String(chroma));
    trim();
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function remove(node) {
    if (!node || node.dataset.leaving) return;
    node.dataset.leaving = "1";
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 220);
  }

  function trim() {
    const rows = [...feed.children].filter((n) => !n.dataset.leaving);
    for (let i = 0; i < rows.length - config.maxRows; i += 1) remove(rows[i]);
  }

  function addEvent(event) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.setProperty("--kind", "var(--kind-" + event.kind + ")");

    const name = event.user && event.user.nickname ? event.user.nickname : "Someone";
    const initial = name.trim().charAt(0).toUpperCase() || "?";
    const avatarUrl = event.user && event.user.avatarUrl;
    const time = new Date(event.at || Date.now())
      .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

    const avatar = !config.showAvatars ? "" :
      avatarUrl
        ? '<img class="avatar" alt="" loading="lazy" src="' + esc(avatarUrl) + '" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'avatar\',textContent:\'' + esc(initial) + '\'}))" />'
        : '<div class="avatar" aria-hidden="true">' + esc(initial) + "</div>";

    row.innerHTML =
      '<div class="rail"></div>' + avatar +
      '<div class="body"><div class="name">' + esc(name) + "</div>" +
      '<div class="text">' + esc(event.text) + "</div></div>" +
      (config.showTimestamps ? '<div class="time">' + esc(time) + "</div>" : "<div></div>");

    feed.appendChild(row);
    trim();
    if (config.rowTtlMs > 0) setTimeout(() => remove(row), config.rowTtlMs);
  }

  let socket = null;
  let retry = 500;

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(proto + "://" + location.host + "/ws");

    socket.onopen = () => { retry = 500; };
    socket.onmessage = (message) => {
      let payload;
      try { payload = JSON.parse(message.data); } catch { return; }
      if (payload.type === "config") { config = Object.assign(config, payload.config); applyConfig(); }
      else if (payload.type === "events") { (payload.events || []).forEach(addEvent); }
      else if (payload.type === "clear") { feed.replaceChildren(); }
    };
    // OBS keeps the source alive across scene switches; reconnect forever with
    // a capped backoff so the overlay heals itself without user action.
    socket.onclose = () => {
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
    socket.onerror = () => socket && socket.close();
  }

  applyConfig();
  connect();
})();
</script>
</body>
</html>`;
