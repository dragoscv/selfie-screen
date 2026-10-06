import { ANCHORS, BODY_JOINTS, bodyCapsules, type Pinhole, type Vec3 } from "@tiksee/pets";
import { useEffect, useRef } from "react";

import type { Debug3dState } from "../../lib/studio/controller.js";
import { useStudio } from "./context.js";
import {
    BONES,
    BOX_EDGES,
    CARD_H,
    CARD_W,
    DEPTH_MARKS_M,
    add3,
    capsuleOutline,
    cardPosition,
    depthColor,
    distanceLine,
    dotRadius,
    facing,
    fadeAlpha,
    floorGrid,
    hudLine,
    metres,
    moodDot,
    needBars,
    petBox,
    pushBadge,
    scale3,
    utilityBars,
    wallGrid,
    worldToShell,
    type Segment,
} from "./debug3d-geometry.js";
import type { Rect } from "./geometry.js";

/** Redraw at the engine's rate: at 30 Hz the wireframes visibly stepped against the 60 fps pets. */
const FRAME_MS = 1000 / 61;
/** Floor grid starts this far in front of the camera. */
const NEAR_FLOOR_M = 0.3;
const FONT = "600 11px ui-sans-serif, system-ui, sans-serif";
const SHADOW = "rgb(0 0 0 / 0.85)";
const SIDE_COLOR = { left: "#f472b6", right: "#38bdf8" } as const;
const SMALL_FONT = "600 10px ui-sans-serif, system-ui, sans-serif";
const CAPSULE_COLOR = "rgb(103 232 249 / 0.45)";

/**
 * Preview-only 3D debug overlay (F3): how the studio understands the scene in
 * metres. One 2D canvas redrawn from `controller.debug3d()` in its own rAF loop;
 * React never re-renders per frame. Never reaches the output / virtual camera.
 */
export function Debug3d() {
    const { controller, rectRef } = useStudio();
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        const g = canvas?.getContext("2d");
        if (!canvas || !g) return;
        let raf = 0;
        let last = 0;
        let w = 0;
        let h = 0;
        const resize = () => {
            const dpr = window.devicePixelRatio || 1;
            w = canvas.clientWidth;
            h = canvas.clientHeight;
            canvas.width = Math.max(1, Math.round(w * dpr));
            canvas.height = Math.max(1, Math.round(h * dpr));
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            last = 0;
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);
        const tick = (now: number) => {
            raf = requestAnimationFrame(tick);
            if (now - last < FRAME_MS) return;
            last = now;
            g.clearRect(0, 0, w, h);
            const state = controller.debug3d();
            const rect = rectRef.current;
            if (state && rect.width > 0 && state.pin.width > 0) draw(g, state, rect);
        };
        raf = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [controller, rectRef]);

    return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 size-full" />;
}

/* ------------------------------------------------------------------ *
 * Drawing (imperative, per frame)
 * ------------------------------------------------------------------ */

type Ctx = CanvasRenderingContext2D;

function draw(g: Ctx, s: Debug3dState, rect: Rect): void {
    g.save();
    // Nothing outside the output image: the shell may letterbox it.
    g.beginPath();
    g.rect(rect.left, rect.top, rect.width, rect.height);
    g.clip();
    g.font = FONT;
    g.textBaseline = "middle";
    drawGrids(g, s, rect);
    drawAnchors(g, s, rect);
    if (s.body?.present) {
        drawCapsules(g, s, rect);
        drawBody(g, s, rect);
    }
    for (const pet of s.pets) drawPet(g, s.pin, rect, pet);
    drawMindCards(g, s, rect);
    g.restore();
    drawHud(g, s, rect);
}

function segments(g: Ctx, pin: Pinhole, rect: Rect, segs: readonly Segment[], color: (d: number) => string): void {
    g.lineWidth = 1;
    for (const seg of segs) {
        const a = worldToShell(pin, rect, seg.a);
        const b = worldToShell(pin, rect, seg.b);
        if (!a || !b) continue;
        g.strokeStyle = color(seg.depthM);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
    }
}

function label(g: Ctx, text: string, x: number, y: number, color = "#fff"): void {
    g.lineWidth = 3;
    g.strokeStyle = SHADOW;
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
}

function drawGrids(g: Ctx, s: Debug3dState, rect: Rect): void {
    const body = s.body?.present ? s.body : null;
    // Room frame: the real floor is y = 0. Grid only in FRONT of the owner's body plane
    // (room -Z < owner), so it never shows through the person.
    const ownerZ = body ? -(body.joints.leftShoulder.p[2] + body.joints.rightShoulder.p[2]) / 2 : Infinity;
    const stopZ = Number.isFinite(ownerZ) ? ownerZ - 0.15 : Infinity;
    segments(g, s.pin, rect, floorGrid(s.pin, 0, NEAR_FLOOR_M, 4, 0.25, stopZ), (d) => `rgb(125 211 252 / ${fadeAlpha(d).toFixed(3)})`);
    for (const d of DEPTH_MARKS_M) {
        if (d > stopZ) continue;
        const p = worldToShell(s.pin, rect, [0, 0, -d]);
        if (p && p.y < rect.top + rect.height && p.y > rect.top) label(g, `${d} m`, p.x + 4, p.y - 6, "rgb(186 230 253)");
    }
    // Camera height label (the room frame's origin).
    label(g, `cam ${metres(s.pin.heightM ?? 0)} · tilt ${(s.pin.tiltDeg ?? 0).toFixed(1)}°`, rect.left + 10, rect.top + rect.height - 14, "rgb(186 230 253)");
    if (!body) return;
    // Depth wall: a 1 m wide metric rectangle standing on the floor at the owner's plane,
    // up to 2 m (a seated owner's shoulders sit ~1.1-1.3 m up).
    const cx = (body.joints.leftShoulder.p[0] + body.joints.rightShoulder.p[0]) / 2;
    const wall = wallGrid(cx, 1, ownerZ);
    segments(g, s.pin, rect, wall, () => "rgb(250 204 21 / 0.22)");
    const corner = worldToShell(s.pin, rect, [cx - 0.5, 2, -ownerZ]);
    if (corner) label(g, `1 × 2 m @ ${metres(body.distanceM)}`, corner.x + 4, corner.y + 8, "rgb(253 224 71)");
    // Shoulder height above the floor: sanity check for camera height + tilt.
    const shoulderY = (body.joints.leftShoulder.p[1] + body.joints.rightShoulder.p[1]) / 2;
    const sp = worldToShell(s.pin, rect, [cx, shoulderY, -ownerZ]);
    if (sp) label(g, `shoulders ${metres(shoulderY)} above floor`, sp.x - 60, sp.y + 22, "rgb(253 224 71)");
}

function drawBody(g: Ctx, s: Debug3dState, rect: Rect): void {
    const body = s.body;
    if (!body) return;
    const j = body.joints;
    g.lineWidth = 2.5;
    for (const [a, b] of BONES) {
        const ja = j[a];
        const jb = j[b];
        const pa = worldToShell(s.pin, rect, ja.p);
        const pb = worldToShell(s.pin, rect, jb.p);
        if (!pa || !pb) continue;
        const conf = Math.min(ja.conf, jb.conf);
        g.strokeStyle = depthColor((pa.depthM + pb.depthM) / 2, 0.25 + 0.6 * conf);
        g.setLineDash(conf < 0.5 ? [4, 4] : []);
        g.beginPath();
        g.moveTo(pa.x, pa.y);
        g.lineTo(pb.x, pb.y);
        g.stroke();
    }
    g.setLineDash([]);
    for (const name of BODY_JOINTS) {
        const joint = j[name];
        const p = worldToShell(s.pin, rect, joint.p);
        if (!p) continue;
        g.fillStyle = depthColor(p.depthM, 0.25 + 0.75 * joint.conf);
        g.beginPath();
        g.arc(p.x, p.y, dotRadius(p.depthM), 0, Math.PI * 2);
        g.fill();
        if (name === "leftShoulder" || name === "rightShoulder") label(g, metres(p.depthM), p.x + 8, p.y + 10);
    }
    // Shoulder span.
    const ls = worldToShell(s.pin, rect, j.leftShoulder.p);
    const rs = worldToShell(s.pin, rect, j.rightShoulder.p);
    if (ls && rs) label(g, `${Math.round(body.shoulders.span * 100)} cm`, (ls.x + rs.x) / 2 - 16, (ls.y + rs.y) / 2 - 10, "rgb(253 224 71)");
    // Head: centre, forward arrow, crown, axes gizmo.
    const head = worldToShell(s.pin, rect, body.head.p);
    if (head) {
        arrow(g, s.pin, rect, body.head.p, add3(body.head.p, scale3(body.head.forward, 0.15)), "rgb(255 255 255 / 0.9)");
        label(g, metres(head.depthM), head.x + 10, head.y - 12);
        axes(g, s.pin, rect, body.head.p);
    }
    const crown = worldToShell(s.pin, rect, body.crown);
    if (crown) {
        g.fillStyle = "#fde047";
        g.beginPath();
        g.arc(crown.x, crown.y, 3.5, 0, Math.PI * 2);
        g.fill();
    }
}

function axes(g: Ctx, pin: Pinhole, rect: Rect, at: Vec3): void {
    arrow(g, pin, rect, at, add3(at, [0.1, 0, 0]), "#ef4444");
    arrow(g, pin, rect, at, add3(at, [0, 0.1, 0]), "#22c55e");
    arrow(g, pin, rect, at, add3(at, [0, 0, 0.1]), "#3b82f6");
}

function arrow(g: Ctx, pin: Pinhole, rect: Rect, from: Vec3, to: Vec3, color: string): void {
    const a = worldToShell(pin, rect, from);
    const b = worldToShell(pin, rect, to);
    if (!a || !b) return;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    g.beginPath();
    g.moveTo(b.x, b.y);
    g.lineTo(b.x - 7 * Math.cos(ang - 0.45), b.y - 7 * Math.sin(ang - 0.45));
    g.lineTo(b.x - 7 * Math.cos(ang + 0.45), b.y - 7 * Math.sin(ang + 0.45));
    g.closePath();
    g.fill();
}

function drawAnchors(g: Ctx, s: Debug3dState, rect: Rect): void {
    g.lineWidth = 1.5;
    for (const side of ["left", "right"] as const) {
        const points = s.anchors[side];
        for (const id of ANCHORS) {
            const p3 = points[id];
            if (!p3) continue;
            const p = worldToShell(s.pin, rect, p3);
            if (!p) continue;
            g.strokeStyle = SIDE_COLOR[side];
            g.beginPath();
            g.arc(p.x, p.y, 5, 0, Math.PI * 2);
            g.stroke();
            label(g, id, p.x + 7, p.y + (side === "left" ? -7 : 7), SIDE_COLOR[side]);
        }
    }
}

function drawPet(g: Ctx, pin: Pinhole, rect: Rect, pet: Debug3dState["pets"][number]): void {
    const { pose } = pet;
    const color = SIDE_COLOR[pet.side];
    // Path (dashed).
    if (pose.path.length > 1) {
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.setLineDash([6, 5]);
        g.beginPath();
        let started = false;
        for (const q of pose.path) {
            const p = worldToShell(pin, rect, q);
            if (!p) continue;
            if (started) g.lineTo(p.x, p.y);
            else g.moveTo(p.x, p.y);
            started = true;
        }
        g.stroke();
    }
    // Look-at line (dashed, white).
    const eye = add3(pose.p, [0, 0.15, 0]);
    const from = worldToShell(pin, rect, eye);
    const look = worldToShell(pin, rect, pose.lookAt);
    if (from && look) {
        g.strokeStyle = "rgb(255 255 255 / 0.6)";
        g.lineWidth = 1;
        g.setLineDash([2, 4]);
        g.beginPath();
        g.moveTo(from.x, from.y);
        g.lineTo(look.x, look.y);
        g.stroke();
    }
    g.setLineDash([]);
    // Wireframe box.
    const corners = petBox(pose.p, pose.yaw).map((c) => worldToShell(pin, rect, c));
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.globalAlpha = pet.animating ? 1 : 0.5;
    for (const [i, k] of BOX_EDGES) {
        const a = corners[i];
        const b = corners[k];
        if (!a || !b) continue;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
    }
    g.globalAlpha = 1;
    arrow(g, pin, rect, add3(pose.p, [0, 0.02, 0]), add3(pose.p, add3([0, 0.02, 0], scale3(facing(pose.yaw), 0.15))), color);
    // Contact point.
    const c = { x: rect.left + pet.screen.u * rect.width, y: rect.top + pet.screen.v * rect.height };
    g.fillStyle = color;
    g.beginPath();
    g.arc(c.x, c.y, 4, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#fff";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(c.x - 8, c.y);
    g.lineTo(c.x + 8, c.y);
    g.moveTo(c.x, c.y - 8);
    g.lineTo(c.x, c.y + 8);
    g.stroke();
    // Labels + occlusion bar.
    const state = `${pose.anchor} · ${pose.settled ? "settled" : (pose.gait ?? "move")} · ${metres(pet.screen.depthM)}${pet.animating ? "" : " · LOD"}`;
    label(g, `${pet.pet}`, c.x + 10, c.y + 12, color);
    label(g, state, c.x + 10, c.y + 26);
    const bx = c.x + 10;
    const by = c.y + 36;
    g.fillStyle = "rgb(0 0 0 / 0.6)";
    g.fillRect(bx, by, 60, 5);
    g.fillStyle = "#f97316";
    g.fillRect(bx, by, 60 * Math.min(1, Math.max(0, pet.personInFront)), 5);
    label(g, `occl ${Math.round(pet.personInFront * 100)}%`, bx + 66, by + 3, "#fdba74");
}

/** Owner collision volume the pets are kept out of (faint cyan wireframe). */
function drawCapsules(g: Ctx, s: Debug3dState, rect: Rect): void {
    g.strokeStyle = CAPSULE_COLOR;
    g.lineWidth = 1;
    g.beginPath();
    for (const c of bodyCapsules(s.body)) {
        const o = capsuleOutline(s.pin, rect, c);
        if (!o) continue;
        for (const k of o.circles) {
            g.moveTo(k.x + k.r, k.y);
            g.arc(k.x, k.y, k.r, 0, Math.PI * 2);
        }
        for (const [a, b] of o.sides) {
            g.moveTo(a.x, a.y);
            g.lineTo(b.x, b.y);
        }
    }
    g.stroke();
}

/** Per pet: utility-AI decision, top-5 scores, needs, mood and constraint push. */
function drawMindCards(g: Ctx, s: Debug3dState, rect: Rect): void {
    let slot = 0;
    for (const pet of s.pets) {
        const onScreen = pet.screen.depthM > 0 && pet.screen.u >= 0 && pet.screen.u <= 1 && pet.screen.v >= 0 && pet.screen.v <= 1;
        const at = onScreen ? { x: rect.left + pet.screen.u * rect.width, y: rect.top + pet.screen.v * rect.height } : null;
        const pos = cardPosition(rect, at, slot);
        if (!at) slot++;
        drawMindCard(g, pos.x, pos.y, pet);
    }
}

function drawMindCard(g: Ctx, x: number, y: number, pet: Debug3dState["pets"][number]): void {
    const color = SIDE_COLOR[pet.side];
    const { decision, needs, mood } = pet.mind;
    g.fillStyle = "rgb(0 0 0 / 0.62)";
    g.beginPath();
    g.roundRect(x, y, CARD_W, CARD_H, 6);
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.stroke();
    g.textBaseline = "middle";
    // Header: name + action, reason below.
    g.font = FONT;
    g.fillStyle = color;
    g.fillText(pet.pet, x + 6, y + 9, 60);
    g.fillStyle = "#fff";
    g.fillText(decision?.action ?? "—", x + 60, y + 9, CARD_W - 66);
    g.font = SMALL_FONT;
    g.fillStyle = "rgb(226 232 240 / 0.85)";
    g.fillText(decision?.reason ?? "no decision yet", x + 6, y + 22, CARD_W - 12);
    // Utility bars (top 5, normalised to the best; chosen highlighted).
    const bars = utilityBars(decision?.ranking ?? [], decision?.action ?? null);
    const barX = x + 74;
    const barW = CARD_W - 80 - 28;
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        if (!b) continue;
        const by = y + 32 + i * 11;
        g.fillStyle = b.chosen ? color : "rgb(203 213 225 / 0.8)";
        g.fillText(b.action, x + 6, by + 4, 66);
        g.fillStyle = "rgb(255 255 255 / 0.12)";
        g.fillRect(barX, by, barW, 7);
        g.fillStyle = b.chosen ? color : "rgb(148 163 184)";
        g.fillRect(barX, by, barW * b.frac, 7);
        g.fillStyle = "rgb(226 232 240 / 0.85)";
        g.fillText(b.score.toFixed(2), barX + barW + 3, by + 4, 26);
    }
    // Needs: five tiny vertical bars.
    const ny = y + CARD_H - 34;
    const needs5 = needBars(needs);
    for (let i = 0; i < needs5.length; i++) {
        const n = needs5[i];
        if (!n) continue;
        const nx = x + 8 + i * 18;
        g.fillStyle = "rgb(255 255 255 / 0.12)";
        g.fillRect(nx, ny, 8, 20);
        g.fillStyle = "#a3e635";
        g.fillRect(nx, ny + 20 * (1 - n.frac), 8, 20 * n.frac);
        g.fillStyle = "rgb(226 232 240 / 0.85)";
        g.fillText(n.label, nx - 1, ny + 27, 16);
    }
    // Mood: valence (x, -1..1) / arousal (y, 0..1) square.
    const mx = x + 100;
    const size = 26;
    const my = y + CARD_H - 32;
    g.strokeStyle = "rgb(255 255 255 / 0.35)";
    g.strokeRect(mx, my, size, size);
    g.beginPath();
    g.moveTo(mx + size / 2, my);
    g.lineTo(mx + size / 2, my + size);
    g.stroke();
    const dot = moodDot(mood, mx, my, size);
    g.fillStyle = "#facc15";
    g.beginPath();
    g.arc(dot.x, dot.y, 3, 0, Math.PI * 2);
    g.fill();
    // Constraint push badge.
    const push = pushBadge(pet.pushed);
    if (push) {
        g.font = SMALL_FONT;
        const bw = g.measureText(push).width + 8;
        const px = x + CARD_W - bw - 4;
        const py = y - 8;
        g.fillStyle = "#dc2626";
        g.beginPath();
        g.roundRect(px, py, bw, 14, 3);
        g.fill();
        g.fillStyle = "#fff";
        g.fillText(push, px + 4, py + 7);
    }
    g.font = FONT;
}

function drawHud(g: Ctx, s: Debug3dState, rect: Rect): void {
    const lines = [hudLine(s), distanceLine(s)];
    g.font = FONT;
    const x = rect.left + 8;
    let y = rect.top + 8;
    for (const text of lines) {
        const w = g.measureText(text).width + 16;
        g.fillStyle = "rgb(0 0 0 / 0.65)";
        g.beginPath();
        g.roundRect(x, y, Math.min(w, rect.width - 16), 20, 6);
        g.fill();
        g.fillStyle = "#fff";
        g.textBaseline = "middle";
        g.fillText(text, x + 8, y + 10, rect.width - 32);
        y += 22;
    }
}
