#!/usr/bin/env node
// Summarise "[trace]" lines from a TikSee dev log (apps/desktop/src/lib/studio/trace.ts).
// Usage: node scripts/trace-report.mjs <log> [--since HH:MM:SS] [--last N]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
    console.error("usage: trace-report.mjs <log> [--since HH:MM:SS] [--last N]");
    process.exit(2);
}
const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const since = opt("--since");
const lastN = Number(opt("--last") ?? 0);

let lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.includes("[trace] t="));
if (since) lines = lines.filter((l) => (l.match(/^(\d\d:\d\d:\d\d)/)?.[1] ?? "") >= since);
if (lastN > 0) lines = lines.slice(-lastN);
if (!lines.length) {
    console.log("no trace lines");
    process.exit(0);
}

const kv = (s) => Object.fromEntries(s.trim().split(/\s+/).map((p) => p.split("=")).filter((p) => p.length === 2));
let frames = lines.map((l) => {
    const body = l.slice(l.indexOf("[trace] ") + 8);
    const [head, ...parts] = body.split(" | ");
    const h = kv(head);
    return { clock: l.match(/^(\d\d:\d\d:\d\d)/)?.[1] ?? "", t: Number(h.t), grab: h.grab, owner: Number(h.owner), parts: parts.map(kv) };
});
// A page reload restarts performance.now(): keep the last continuous segment.
for (let i = frames.length - 1; i > 0; i--) {
    if ((frames[i]?.t ?? 0) < (frames[i - 1]?.t ?? 0)) {
        frames = frames.slice(i);
        break;
    }
}

const q = (v, p) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const fmt = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : "-");

const pets = new Map();
const hands = new Map();
for (const f of frames) {
    for (const p of f.parts) {
        if (p.pet) {
            const s = pets.get(p.pet) ?? { n: 0, prev: null, du: [], dz: [], sc: [], z: [], anchors: new Map(), switches: 0, acts: new Map(), clips: new Map(), held: 0, pushed: 0, gaits: new Map() };
            const [u, v] = p.uv.split(",").map(Number);
            const z = Number(p.z);
            const sc = Number(p.sc);
            if (s.prev) {
                const dt = (f.t - s.prev.t) / 1000;
                if (dt > 0 && dt < 0.5) {
                    s.du.push(Math.hypot(u - s.prev.u, v - s.prev.v) / dt);
                    s.dz.push(Math.abs(z - s.prev.z) / dt);
                }
                if (p.a !== s.prev.a) s.switches++;
            }
            s.prev = { t: f.t, u, v, z, a: p.a };
            s.n++;
            s.sc.push(sc);
            s.z.push(z);
            s.anchors.set(p.a, (s.anchors.get(p.a) ?? 0) + 1);
            s.acts.set(p.act, (s.acts.get(p.act) ?? 0) + 1);
            if (p.clip) s.clips.set(p.clip, (s.clips.get(p.clip) ?? 0) + 1);
            s.gaits.set(p.gait, (s.gaits.get(p.gait) ?? 0) + 1);
            if (p.held === "1") s.held++;
            if (Number(p.push) > 0.005) s.pushed++;
            pets.set(p.pet, s);
        } else if (p.hand) {
            const s = hands.get(p.hand) ?? { n: 0, pin: 0, shapes: new Map(), z: [] };
            s.n++;
            if (p.pin === "1") s.pin++;
            s.shapes.set(p.shape, (s.shapes.get(p.shape) ?? 0) + 1);
            s.z.push(Number(p.z));
            hands.set(p.hand, s);
        }
    }
}

const span = (frames.at(-1).t - frames[0].t) / 1000;
const top = (m, n = 4) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k}:${c}`).join(" ");
const owners = frames.map((f) => f.owner);
console.log(
    `frames=${frames.length} ${frames[0].clock}-${frames.at(-1).clock} span=${span.toFixed(1)}s owner p10=${fmt(q(owners, 0.1), 2)} p50=${fmt(q(owners, 0.5), 2)} p90=${fmt(q(owners, 0.9), 2)}m grabbed=${frames.filter((f) => f.grab !== "-").length}`,
);
if (args.includes("--timeline")) {
    const step = args.includes("--every") ? 1 : Math.max(1, Math.floor(frames.length / 40));
    for (let i = 0; i < frames.length; i += step) {
        const f = frames[i];
        const ps = f.parts.filter((p) => p.pet).map((p) => `${p.pet} ${p.a}/${p.act}${p.clip ? `/${p.clip}` : ""} uv=${p.uv} z=${p.z} sc=${p.sc}${p.held === "1" ? " HELD" : ""}`);
        const hs = f.parts.filter((p) => p.hand).map((p) => `${p.hand}:${p.shape}${p.pin === "1" ? "*" : ""}${p.uv ? ` uv=${p.uv} size=${p.size}` : ""}`);
        console.log(`  ${f.clock} owner=${f.owner} grab=${f.grab} | ${ps.join(" | ")} | ${hs.join(" ")}`);
    }
}
for (const [id, s] of pets) {
    console.log(
        `${id}: n=${s.n} screen speed (frame-heights/s) p50=${fmt(q(s.du, 0.5))} p90=${fmt(q(s.du, 0.9))} max=${fmt(Math.max(...s.du))}` +
            ` | depth z p10=${fmt(q(s.z, 0.1), 2)} p90=${fmt(q(s.z, 0.9), 2)} dz/s p90=${fmt(q(s.dz, 0.9), 2)}` +
            ` | scale min=${fmt(Math.min(...s.sc), 2)} max=${fmt(Math.max(...s.sc), 2)}` +
            ` | anchor switches=${s.switches} (${(s.switches / Math.max(span, 1e-3)).toFixed(2)}/s) ${top(s.anchors)}` +
            ` | acts ${top(s.acts)} | clips ${top(s.clips)} | gait ${top(s.gaits)} | held=${s.held} pushed=${s.pushed}`,
    );
}
for (const [side, s] of hands) console.log(`hand ${side}: n=${s.n} pinching=${s.pin} shapes ${top(s.shapes, 5)} z p10=${fmt(q(s.z, 0.1), 2)} p90=${fmt(q(s.z, 0.9), 2)}`);
