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

    /* --- widgets: goals + chat games, pinned to the top --- */
    #widgets {
      position: absolute; inset: 14px 14px auto 14px; z-index: 2;
      display: flex; flex-direction: column; gap: var(--gap);
      pointer-events: none;
    }
    #widgets:empty { display: none; }
    .card {
      padding: 10px 12px; border-radius: var(--radius);
      background: var(--row-bg); color: var(--row-fg);
      backdrop-filter: blur(14px) saturate(1.25);
      box-shadow: 0 6px 22px rgb(0 0 0 / 0.28);
    }
    .goal-head, .opt-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; font-weight: 700; }
    .goal-head .num, .opt-head .num { font-variant-numeric: tabular-nums; color: var(--row-dim); font-weight: 600; }
    .bar { height: 10px; margin-top: 6px; border-radius: 999px; overflow: hidden; background: color-mix(in oklab, var(--row-fg) 12%, transparent); }
    .fill {
      height: 100%; width: 0; border-radius: inherit;
      background: linear-gradient(90deg, var(--fill), color-mix(in oklab, var(--fill) 60%, white));
      transition: width 600ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .goal.done .fill { box-shadow: 0 0 14px var(--fill); }
    .goal + .goal { margin-top: 10px; }
    .q { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
    .opt + .opt { margin-top: 8px; }
    .hint { font-size: 11.5px; color: var(--row-dim); margin-top: 6px; }
    .win { font-size: 15px; font-weight: 800; color: var(--kind-gift); }
    .wheel-wrap { position: relative; width: 220px; height: 220px; margin: 4px auto 0; }
    .wheel-wrap canvas { width: 100%; height: 100%; border-radius: 50%; }
    .pointer {
      position: absolute; left: 50%; top: -6px; transform: translateX(-50%);
      width: 0; height: 0; border-left: 10px solid transparent; border-right: 10px solid transparent;
      border-top: 18px solid var(--row-fg); filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.5));
    }
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
    html[data-reduced-motion="true"] .fill { transition: none; }
    @media (prefers-reduced-motion: reduce) {
      .row, .row.leaving { animation: none; }
      .fill { transition: none; }
    }
  }
</style>
</head>
<body>
<div id="widgets" aria-live="polite"></div>
<div id="feed" role="log" aria-live="polite" aria-label="Live chat"></div>
<script>
(() => {
  "use strict";
  const feed = document.getElementById("feed");
  const widgets = document.getElementById("widgets");
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

  /* ---------------- goals + games ---------------- */

  const GOAL_TEXT = { gifts: "Gift goal", likes: "Like goal" };
  const GOAL_COLOR = { gifts: "var(--kind-gift)", likes: "var(--kind-like)" };
  const WHEEL_SPIN_MS = 6000;
  const WHEEL_COLORS = ["#62D6FF", "#FFB454", "#4ADE80", "#A78BFA", "#F87171", "#38BDF8", "#F472B6", "#FACC15"];
  let goalsState = null;
  let gameState = null;
  let wheelKey = "";
  /** Last rendered width per bar, so a re-render animates from where it was. */
  const lastWidth = {};

  function nf(n) { return Number(n || 0).toLocaleString(); }
  function fill(key, pct) {
    const from = lastWidth[key] || 0;
    return '<div class="fill" data-k="' + key + '" data-w="' + pct + '" style="width:' + from + '%"></div>';
  }
  function reducedMotion() {
    return !!config.reducedMotion || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function goalsHtml() {
    if (!goalsState || !goalsState.overlay || !goalsState.goals.length) return "";
    return '<div class="card" id="goals">' + goalsState.goals.map((g) => (
      '<div class="goal' + (g.reached ? " done" : "") + '" style="--fill:' + GOAL_COLOR[g.kind] + '">' +
        '<div class="goal-head"><span>' + esc(g.label || GOAL_TEXT[g.kind] || g.kind) + "</span>" +
        '<span class="num">' + nf(g.current) + " / " + nf(g.target) + "</span></div>" +
        '<div class="bar">' + fill("goal-" + g.kind, Math.round(g.ratio * 1000) / 10) + "</div>" +
      "</div>"
    )).join("") + "</div>";
  }

  function gameHtml() {
    const g = gameState;
    if (!g || g.kind === "none") return "";
    if (g.kind === "poll") {
      const total = Math.max(1, g.totalVotes);
      return '<div class="card"><div class="q">' + esc(g.question) + "</div>" + g.options.map((o, i) => (
        '<div class="opt" style="--fill:' + WHEEL_COLORS[i % WHEEL_COLORS.length] + '">' +
          '<div class="opt-head"><span>' + (i + 1) + ". " + esc(o.label) + "</span>" +
          '<span class="num">' + Math.round((o.votes / total) * 100) + "% · " + nf(o.votes) + "</span></div>" +
          '<div class="bar">' + fill(g.id + "-" + i, Math.round((o.votes / total) * 1000) / 10) + "</div>" +
        "</div>"
      )).join("") + '<div class="hint">' + (g.open ? "Type the number to vote" : "Poll closed") + " · " + nf(g.totalVotes) + "</div></div>";
    }
    if (g.kind === "quiz") {
      const body = g.winner
        ? '<div class="win">🏆 ' + esc(g.winner.nickname) + "</div>" + (g.answer ? '<div class="hint">' + esc(g.answer) + "</div>" : "")
        : g.open ? '<div class="hint">First correct answer wins · ' + nf(g.attempts) + "</div>"
        : '<div class="hint">' + esc(g.answer || "") + "</div>";
      return '<div class="card"><div class="q">' + esc(g.question) + "</div>" + body + "</div>";
    }
    if (g.kind === "wheel") {
      const caption = g.winner ? '<div class="win" style="text-align:center">🎉 ' + esc(g.winner.nickname) + "</div>"
        : g.spinning ? '<div class="hint" style="text-align:center">…</div>'
        : '<div class="hint" style="text-align:center">Type <b>' + esc(g.keyword) + "</b> to enter · " + nf(g.entrantCount) + "</div>";
      return '<div class="card"><div class="wheel-wrap"><canvas width="440" height="440"></canvas><div class="pointer"></div></div>' + caption + "</div>";
    }
    return "";
  }

  function drawWheel(canvas, segments) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const n = Math.max(1, segments.length);
    const r = canvas.width / 2;
    const step = (Math.PI * 2) / n;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(r, r);
    for (let i = 0; i < n; i += 1) {
      // Segment i spans clockwise from the top.
      const a0 = -Math.PI / 2 + i * step;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 2, a0, a0 + step);
      ctx.closePath();
      ctx.fillStyle = segments.length ? WHEEL_COLORS[i % WHEEL_COLORS.length] : "#334155";
      ctx.fill();
      ctx.save();
      ctx.rotate(a0 + step / 2);
      ctx.fillStyle = "#0B0E14";
      ctx.font = "700 " + (n > 16 ? 16 : 20) + "px Segoe UI, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const label = String(segments[i] || "").slice(0, 14);
      ctx.fillText(label, r - 14, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function spinWheel(canvas, g) {
    const n = Math.max(1, g.segments.length);
    const seg = 360 / n;
    const finalDeg = 360 * 6 - ((g.winnerIndex || 0) + 0.5) * seg;
    const elapsed = Math.max(0, Date.now() - (g.spinAt || Date.now()));
    const remaining = g.spinning ? Math.max(0, WHEEL_SPIN_MS - elapsed) : 0;
    if (reducedMotion() || remaining < 50) {
      canvas.style.transition = "none";
      canvas.style.transform = "rotate(" + finalDeg + "deg)";
      return;
    }
    canvas.style.transition = "none";
    canvas.style.transform = "rotate(0deg)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      canvas.style.transition = "transform " + remaining + "ms cubic-bezier(0.12, 0.8, 0.2, 1)";
      canvas.style.transform = "rotate(" + finalDeg + "deg)";
    }));
  }

  function renderWidgets() {
    const g = gameState;
    // Keep the spinning canvas alive across updates: re-render only on a new spin or game.
    const key = g && g.kind === "wheel" ? g.id + ":" + (g.spinAt || 0) + ":" + g.segments.length + ":" + (g.winner ? 1 : 0) : "";
    const existing = widgets.querySelector("canvas");
    const keepWheel = existing && key !== "" && key === wheelKey;
    if (keepWheel) {
      const goalsCard = widgets.querySelector("#goals");
      const html = goalsHtml();
      if (goalsCard) goalsCard.outerHTML = html || "";
      else if (html) widgets.insertAdjacentHTML("afterbegin", html);
    } else {
      widgets.innerHTML = goalsHtml() + gameHtml();
    }
    requestAnimationFrame(() => {
      widgets.querySelectorAll(".fill").forEach((el) => {
        el.style.width = el.dataset.w + "%";
        lastWidth[el.dataset.k] = Number(el.dataset.w);
      });
    });
    const canvas = widgets.querySelector("canvas");
    if (canvas && g && g.kind === "wheel" && !keepWheel) {
      drawWheel(canvas, g.segments);
      if (g.spinAt) spinWheel(canvas, g);
    }
    wheelKey = key;
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
      else if (payload.type === "goals") { goalsState = payload.state; renderWidgets(); }
      else if (payload.type === "game") { gameState = payload.state; renderWidgets(); }
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
