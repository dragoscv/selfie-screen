import * as THREE from "three/webgpu";

import {
    BUBBLE_LINE_CHARS,
    MORPH_MS,
    EXIT_MS,
    bubbleDurationMs,
    smoothstep01,
    emotionGlyph,
    exitFactor,
    layoutBubble,
    popScale,
    revealCount,
    revealDurationMs,
} from "./bubble-layout.js";
import { focalPx, project, unproject, type Pinhole, type Vec3 } from "./space.js";

/** Logical canvas size (drawn at 2x for crisp text). */
const W = 512;
const H = 256;
const DPR = 2;
/** Font: 40 logical px on a mesh whose 256 px = 16.6 % of the frame height -> 28 px at 1080. */
const FONT_PX = 40;
const MIN_FONT_PX = 32;
const MESH_FRAC = (28 / 1080) * (H / FONT_PX);
const LINE_K = 1.2;
const PAD_X = 20;
const PAD_Y = 14;
const TAIL_H = 26;
const TAIL_W = 30;
const RADIUS = 26;
const MIN_W = 96;
const REDRAW_MS = 33;
const FONT = (px: number) => `600 ${px}px system-ui, "Segoe UI", "Noto Sans", sans-serif`;
const BG = "rgba(255, 253, 247, 0.96)";
const INK = "#1d1b2e";
const EDGE = "rgba(29, 27, 46, 0.22)";
/** Keep the bubble inside the frame (output-normalised). */
const UV_MIN = 0.08;
const UV_MAX = 0.92;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Size {
    w: number;
    h: number;
}

export interface SayOptions {
    emotion?: string;
    ttlMs?: number;
}

function makeCanvas(): HTMLCanvasElement | OffscreenCanvas {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(W * DPR, H * DPR);
    const c = document.createElement("canvas");
    c.width = W * DPR;
    c.height = H * DPR;
    return c;
}

/**
 * A pet's speech bubble as a real mesh in the stage scene (so it reaches the
 * video output): Canvas2D -> CanvasTexture on a billboarded plane, drawn on top
 * of the pet. Construct only in a browser (the stage creates it on first say).
 */
export class SpeechBubble {
    readonly mesh: THREE.Mesh;
    readonly #canvas: HTMLCanvasElement | OffscreenCanvas;
    readonly #ctx: Ctx;
    readonly #texture: THREE.CanvasTexture<HTMLCanvasElement | OffscreenCanvas>;
    readonly #material: THREE.MeshBasicNodeMaterial;
    #lines: string[] = [];
    #chars = 0;
    #font = FONT_PX;
    #glyph: string | null = null;
    #from: Size = { w: 0, h: 0 };
    #to: Size = { w: 0, h: 0 };
    #morphStart = -Infinity;
    #revealStart = 0;
    #shownAt = 0;
    #expiresAt = 0;
    #lastDraw = -Infinity;
    #drawnChars = -1;
    #drawnSize: Size = { w: -1, h: -1 };
    #active = false;
    readonly #tmpUp = new THREE.Vector3();

    constructor() {
        this.#canvas = makeCanvas();
        const ctx = this.#canvas.getContext("2d") as Ctx | null;
        if (!ctx) throw new Error("2d canvas unavailable");
        this.#ctx = ctx;
        this.#texture = new THREE.CanvasTexture(this.#canvas);
        this.#texture.colorSpace = THREE.SRGBColorSpace;
        this.#texture.generateMipmaps = false;
        this.#texture.minFilter = THREE.LinearFilter;
        const m = new THREE.MeshBasicNodeMaterial();
        m.map = this.#texture;
        m.transparent = true;
        m.depthTest = false;
        m.depthWrite = false;
        m.toneMapped = false;
        m.opacity = 0;
        this.#material = m;
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(W / H, 1), m);
        this.mesh.renderOrder = 1000;
        this.mesh.frustumCulled = false;
        this.mesh.visible = false;
        this.mesh.name = "pet-bubble";
    }

    /** Text currently shown (after layout). */
    get lines(): readonly string[] {
        return this.#lines;
    }

    /** Visible or animating out. */
    get active(): boolean {
        return this.#active;
    }

    /** Show `text`; replaces (and morphs from) the current bubble. */
    say(text: string, nowMs: number, opts: SayOptions = {}): void {
        const lines = layoutBubble(text, BUBBLE_LINE_CHARS);
        if (lines.length === 0) return;
        const visible = this.#active && nowMs < this.#expiresAt;
        const current = this.#size(nowMs);
        this.#lines = lines;
        this.#chars = lines.reduce((n, l) => n + Array.from(l).length, 0);
        this.#glyph = emotionGlyph(opts.emotion);
        this.#to = this.#measure(lines);
        if (visible) {
            this.#from = current;
            this.#morphStart = nowMs;
        } else {
            this.#from = this.#to;
            this.#morphStart = -Infinity;
            this.#shownAt = nowMs;
        }
        this.#revealStart = nowMs;
        const total = this.#lines.join(" ");
        this.#expiresAt = nowMs + Math.max(bubbleDurationMs(total, opts.ttlMs), revealDurationMs(this.#chars) + 800);
        this.#active = true;
        this.#drawnChars = -1;
        this.#lastDraw = -Infinity;
    }

    /** Start the exit animation now. */
    clear(nowMs: number): void {
        if (this.#active && nowMs < this.#expiresAt) this.#expiresAt = nowMs;
    }

    /** Fit the font to the widest line and size the rounded rect. */
    #measure(lines: readonly string[]): Size {
        const ctx = this.#ctx;
        let font = FONT_PX;
        ctx.font = FONT(font);
        const maxText = W - 8 - 2 * PAD_X;
        let widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
        if (widest > maxText) {
            font = Math.max(MIN_FONT_PX, Math.floor((font * maxText) / widest));
            ctx.font = FONT(font);
            widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
        }
        this.#font = font;
        const w = Math.min(W - 8, Math.max(MIN_W, widest + 2 * PAD_X + (this.#glyph ? 12 : 0)));
        const h = Math.min(H - TAIL_H - 6, lines.length * font * LINE_K + 2 * PAD_Y);
        return { w, h };
    }

    #size(nowMs: number): Size {
        const t = smoothstep01((nowMs - this.#morphStart) / MORPH_MS);
        return { w: this.#from.w + (this.#to.w - this.#from.w) * t, h: this.#from.h + (this.#to.h - this.#from.h) * t };
    }

    #draw(size: Size, shown: number): void {
        const ctx = this.#ctx;
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const x = (W - size.w) / 2;
        const bottom = H - TAIL_H - 3;
        const y = bottom - size.h;
        const r = Math.min(RADIUS, size.h / 2);
        const cx = W / 2;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + size.w, y, x + size.w, bottom, r);
        ctx.arcTo(x + size.w, bottom, x, bottom, r);
        // Tail: down to the pet, slightly curved.
        ctx.lineTo(cx + TAIL_W / 2, bottom);
        ctx.quadraticCurveTo(cx + 4, bottom + TAIL_H * 0.5, cx, bottom + TAIL_H);
        ctx.quadraticCurveTo(cx - 6, bottom + TAIL_H * 0.4, cx - TAIL_W / 2, bottom);
        ctx.arcTo(x, bottom, x, y, r);
        ctx.arcTo(x, y, x + size.w, y, r);
        ctx.closePath();
        ctx.shadowColor = "rgba(29, 27, 46, 0.25)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = BG;
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.lineWidth = 2;
        ctx.strokeStyle = EDGE;
        ctx.stroke();
        // Text (final layout; the typewriter reveals it in place so lines never re-wrap).
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, size.w, size.h);
        ctx.clip();
        ctx.font = FONT(this.#font);
        ctx.fillStyle = INK;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lineH = this.#font * LINE_K;
        const top = y + size.h / 2 - (this.#lines.length * lineH) / 2 + lineH / 2;
        let left = shown;
        for (const [i, line] of this.#lines.entries()) {
            const cps = Array.from(line);
            const n = Math.max(0, Math.min(cps.length, left));
            left -= cps.length;
            if (n === 0) continue;
            // Measure the full line so revealed characters do not slide.
            const full = ctx.measureText(line).width;
            ctx.textAlign = "left";
            ctx.fillText(cps.slice(0, n).join(""), cx - full / 2, top + i * lineH);
        }
        ctx.restore();
        if (this.#glyph) {
            const gx = x + size.w - 8;
            const gy = y + 8;
            ctx.beginPath();
            ctx.arc(gx, gy, 17, 0, Math.PI * 2);
            ctx.fillStyle = "#ffffff";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = EDGE;
            ctx.stroke();
            ctx.font = "22px system-ui, \"Segoe UI Emoji\", \"Noto Color Emoji\", sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = INK;
            ctx.fillText(this.#glyph, gx, gy + 1);
        }
        this.#texture.needsUpdate = true;
    }

    /**
     * Animate and place. `anchor` = the point the tail touches (above the pet's
     * head), `fade` = the stage's show/hide fade for that pet.
     */
    update(nowMs: number, anchor: Vec3, pin: Pinhole, camera: THREE.Camera, fade: number): void {
        if (!this.#active) return;
        const since = nowMs - this.#expiresAt;
        if (since >= EXIT_MS) {
            this.#active = false;
            this.mesh.visible = false;
            return;
        }
        const exit = since > 0 ? exitFactor(since) : 1;
        const pop = popScale((nowMs - this.#shownAt) / 1000);
        // Redraw: every frame while morphing; at most every 33 ms while revealing; then never.
        const size = this.#size(nowMs);
        const morphing = nowMs - this.#morphStart < MORPH_MS + 20;
        const shown = revealCount(this.#chars, nowMs - this.#revealStart);
        const sizeChanged = Math.abs(size.w - this.#drawnSize.w) > 0.25 || Math.abs(size.h - this.#drawnSize.h) > 0.25;
        if ((morphing && sizeChanged) || (shown !== this.#drawnChars && nowMs - this.#lastDraw >= REDRAW_MS) || this.#drawnChars < 0) {
            this.#draw(size, shown);
            this.#drawnChars = shown;
            this.#drawnSize = size;
            this.#lastDraw = nowMs;
        }
        // Constant on-screen size: world height = fraction of the frame at this depth.
        const depth = Math.max(project(pin, anchor).depthM, 0.1);
        const worldH = (MESH_FRAC * pin.height * depth) / focalPx(pin);
        const k = Math.max(pop * exit, 1e-3);
        const bob = Math.sin(nowMs / 420) * worldH * 0.015;
        this.mesh.quaternion.copy(camera.quaternion);
        const up = this.#tmpUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
        // The tail tip (canvas bottom) sits on the anchor; scale around it.
        const lift = (worldH * k) / 2 + bob;
        let p: Vec3 = [anchor[0] + up.x * lift, anchor[1] + up.y * lift, anchor[2] + up.z * lift];
        const s = project(pin, p);
        const u = Math.min(UV_MAX, Math.max(UV_MIN, s.u));
        const v = Math.min(UV_MAX, Math.max(UV_MIN, s.v));
        if (u !== s.u || v !== s.v) p = unproject(pin, u, v, s.depthM);
        this.mesh.position.set(p[0], p[1], p[2]);
        this.mesh.scale.setScalar(worldH * k);
        this.#material.opacity = Math.max(0, Math.min(1, fade)) * exit;
        this.mesh.visible = fade > 0.001;
    }

    dispose(): void {
        this.mesh.removeFromParent();
        this.mesh.geometry.dispose();
        this.#texture.dispose();
        this.#material.dispose();
        this.#active = false;
    }
}
