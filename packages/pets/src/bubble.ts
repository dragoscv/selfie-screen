import * as THREE from "three/webgpu";
import { texture, uniform, vec4 } from "three/tsl";

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
    tailOffsetPx,
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
/** Safe margin (output-normalised) the whole bubble rectangle stays inside. */
const SAFE = 0.03;
/** Smallest size (fraction of normal) the bubble shrinks to near the frame edges. */
const MIN_SHRINK = 0.55;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Size {
    w: number;
    h: number;
}

export interface SayOptions {
    emotion?: string;
    ttlMs?: number;
}

/**
 * A DOM canvas, not OffscreenCanvas: three's WebGPU CanvasTexture upload path is the one
 * the AR layer uses (measured: an OffscreenCanvas-backed bubble never appeared, 2026-10-06).
 */
function makeCanvas(): HTMLCanvasElement | OffscreenCanvas {
    if (typeof document === "undefined") return new OffscreenCanvas(W * DPR, H * DPR);
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
    readonly #opacity = uniform(0);
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
    #drawnTail = 0;
    #active = false;
    /** Smoothed edge fit (shrink) and screen offset, so the bubble glides instead of jumping. */
    #fit = 1;
    #shift: [number, number] = [0, 0];
    #placed = false;
    #lastPlace = 0;

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
        // Explicit colour node (texture x opacity uniform), like the AR layer: the stage renders
        // linear output with inline tone mapping, and `.map` + `.opacity` alone drew nothing.
        const t = texture(this.#texture);
        m.colorNode = vec4(t.rgb, t.a.mul(this.#opacity));
        m.transparent = true;
        m.depthTest = false;
        m.depthWrite = false;
        m.toneMapped = false;
        m.side = THREE.DoubleSide;
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
            this.#placed = false;
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

    #draw(size: Size, shown: number, tailPx = 0): void {
        const ctx = this.#ctx;
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const x = (W - size.w) / 2;
        const bottom = H - TAIL_H - 3;
        const y = bottom - size.h;
        const r = Math.min(RADIUS, size.h / 2);
        const cx = W / 2;
        const tx = cx + tailPx;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + size.w, y, x + size.w, bottom, r);
        ctx.arcTo(x + size.w, bottom, x, bottom, r);
        // Tail: down to the pet, slightly curved; follows the pet when the bubble is slid in.
        ctx.lineTo(tx + TAIL_W / 2, bottom);
        ctx.quadraticCurveTo(tx + 4, bottom + TAIL_H * 0.5, tx, bottom + TAIL_H);
        ctx.quadraticCurveTo(tx - 6, bottom + TAIL_H * 0.4, tx - TAIL_W / 2, bottom);
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
        // Screen-space layout: the tail tip sits on the pet's anchor; the bubble keeps a constant
        // on-screen size and slides inside the safe area near the frame edges (the tail bends back
        // toward the pet). It only shrinks (down to MIN_SHRINK) when the room above the pet or the
        // frame width itself is too small. When the pet leaves the frame the bubble waits at the
        // nearest edge and resumes as soon as the pet is back.
        const a = project(pin, anchor);
        const depth = Math.max(a.depthM, 0.1);
        const au = Math.min(1, Math.max(0, a.u));
        const av = Math.min(1, Math.max(0, a.v));
        const hFrac = MESH_FRAC;
        const wFrac = (hFrac * (W / H) * pin.height) / pin.width;
        // Width the drawn rectangle really needs (the canvas is wider than the rounded rect).
        const rectFrac = (wFrac * Math.max(size.w, MIN_W)) / W;
        const spaceX = Math.max(0, 1 - 2 * SAFE);
        const spaceY = Math.max(0, av - SAFE);
        const wantFit = Math.max(MIN_SHRINK, Math.min(1, spaceX / rectFrac, spaceY / hFrac));
        const kf = this.#placed ? 1 - Math.exp(-Math.max(0, nowMs - this.#lastPlace) / 120) : 1;
        this.#lastPlace = nowMs;
        this.#fit += (wantFit - this.#fit) * kf;
        const k = Math.max(pop * exit * this.#fit, 1e-3);
        const bw = wFrac * k;
        const bh = hFrac * k;
        const rw = rectFrac * k;
        const cu0 = au;
        const cv0 = av - bh / 2 + Math.sin(nowMs / 420) * bh * 0.015;
        const tu = Math.min(1 - SAFE - rw / 2, Math.max(SAFE + rw / 2, cu0));
        const tv = Math.min(1 - SAFE - bh / 2, Math.max(SAFE + bh / 2, cv0));
        this.#shift = [this.#shift[0] + (tu - cu0 - this.#shift[0]) * kf, this.#shift[1] + (tv - cv0 - this.#shift[1]) * kf];
        this.#placed = true;
        // Tail x (canvas px from the centre) that keeps pointing at the pet after the slide.
        const tail = tailOffsetPx(-this.#shift[0] / bw, size.w, W, RADIUS + TAIL_W / 2);
        if (
            (morphing && sizeChanged) ||
            (shown !== this.#drawnChars && nowMs - this.#lastDraw >= REDRAW_MS) ||
            this.#drawnChars < 0 ||
            Math.abs(tail - this.#drawnTail) > 1
        ) {
            this.#draw(size, shown, tail);
            this.#drawnChars = shown;
            this.#drawnSize = size;
            this.#drawnTail = tail;
            this.#lastDraw = nowMs;
        }
        const p: Vec3 = unproject(pin, cu0 + this.#shift[0], cv0 + this.#shift[1], depth);
        const worldH = (bh * pin.height * depth) / focalPx(pin);
        this.mesh.quaternion.copy(camera.quaternion);
        this.mesh.position.set(p[0], p[1], p[2]);
        this.mesh.scale.setScalar(Math.max(worldH, 1e-4));
        this.#opacity.value = Math.max(0, Math.min(1, fade)) * exit;
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
