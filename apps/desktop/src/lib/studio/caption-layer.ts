import type { CaptionSettings } from "@tiksee/core";
import * as THREE from "three/webgpu";
import { positionGeometry, texture, uniform, vec4 } from "three/tsl";

import { captionFeed } from "./caption-feed.js";
import { LINE_FRAC, MAX_WIDTH_FRAC, captionLook, charsPerLine, clampCentre, wrapCaption, type CaptionText } from "./caption-draw.js";

/** Texture size: the pill is drawn at up to 1.5x output px and centred inside it. */
const CW = 2048;
const CH = 640;
const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const EMOJI = '"Segoe UI Emoji"';
/** Size morph and fade time constants (s). */
const MORPH_TAU = 0.09;
const FADE_TAU = 0.12;
/** Redraw at most this often while text streams in (ms). */
const REDRAW_MS = 33;

interface Size {
    w: number;
    h: number;
}

/**
 * Live captions drawn INTO the output video (and so the preview, the virtual camera and clips):
 * Canvas2D -> CanvasTexture on a clip-space quad in the stage scene, above pets and bubbles.
 * The pill morphs smoothly to each new size, pops in, fades out when the strip empties and
 * stays inside the frame. Redraws only when the text or the morphing size changes.
 */
export class CaptionLayer {
    readonly #mesh: THREE.Mesh;
    readonly #canvas: HTMLCanvasElement;
    readonly #ctx: CanvasRenderingContext2D;
    readonly #texture: THREE.CanvasTexture<HTMLCanvasElement>;
    readonly #u = {
        centre: uniform(new THREE.Vector2(0, 0)),
        size: uniform(new THREE.Vector2(1, 1)),
        opacity: uniform(0),
    };
    #text: CaptionText = { history: [], main: "", translated: "" };
    #settings: CaptionSettings;
    #cur: Size = { w: 0, h: 0 };
    #alpha = 0;
    #pop = 0;
    #drawn = "";
    #lastDraw = -Infinity;
    #lastNow = 0;
    #off: (() => void) | null = null;
    /** Pill in output-normalised coords (centre + size) for hit-testing in the preview. */
    rect = { u: 0.5, v: 0.5, w: 0, h: 0 };

    constructor(scene: THREE.Scene, settings: CaptionSettings) {
        this.#settings = settings;
        this.#canvas = document.createElement("canvas");
        this.#canvas.width = CW;
        this.#canvas.height = CH;
        const ctx = this.#canvas.getContext("2d");
        if (!ctx) throw new Error("2d canvas unavailable");
        this.#ctx = ctx;
        this.#texture = new THREE.CanvasTexture(this.#canvas);
        this.#texture.colorSpace = THREE.SRGBColorSpace;
        this.#texture.generateMipmaps = false;
        this.#texture.minFilter = THREE.LinearFilter;
        const m = new THREE.MeshBasicNodeMaterial();
        // Clip-space quad (like the camera copy): no camera maths, always on top of the frame.
        m.vertexNode = vec4(positionGeometry.xy.mul(this.#u.size).add(this.#u.centre), 0, 1);
        const t = texture(this.#texture);
        m.colorNode = vec4(t.rgb, t.a.mul(this.#u.opacity));
        m.transparent = true;
        m.depthTest = false;
        m.depthWrite = false;
        m.toneMapped = false;
        m.side = THREE.DoubleSide;
        this.#mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
        this.#mesh.renderOrder = 1100;
        this.#mesh.frustumCulled = false;
        this.#mesh.visible = false;
        this.#mesh.name = "captions";
        scene.add(this.#mesh);
    }

    set settings(s: CaptionSettings) {
        this.#settings = s;
        this.#drawn = "";
        captionFeed.keep = s.lines;
    }

    /** Listening to the live transcript (only while the captions are on the live). */
    get live(): boolean {
        return this.#off !== null;
    }

    /** Follow the shared transcript feed (on) or stop and fade out (off). */
    setLive(on: boolean): void {
        if (on === (this.#off !== null)) return;
        if (!on) {
            this.#off?.();
            this.#off = null;
            this.setText(null);
            return;
        }
        captionFeed.keep = this.#settings.lines;
        this.#off = captionFeed.subscribe((snap) => {
            const newest = snap.lines.at(-1);
            this.setText({
                history: (snap.partial ? snap.lines : snap.lines.slice(0, -1)).map((l) => l.text),
                main: snap.partial || newest?.text || "",
                translated: this.#settings.translate && !snap.partial ? (newest?.translated ?? "") : "",
            });
        });
    }

    setText(text: CaptionText | null): void {
        this.#text = text ?? { history: [], main: "", translated: "" };
    }

    /** Advance one frame for an output of W x H px. */
    update(nowMs: number, W: number, H: number): void {
        const dt = Math.min(Math.max((nowMs - this.#lastNow) / 1000, 0), 0.1);
        this.#lastNow = nowMs;
        const s = this.#settings;
        const lineH = LINE_FRAC * H * s.scale;
        const wrapped = wrapCaption(this.#text, charsPerLine(W / H, s.scale), s.rows);
        const empty = wrapped.main.length === 0 && wrapped.translated.length === 0 && wrapped.history.length === 0;
        const ctx = this.#ctx;

        // Target pill size in OUTPUT px from the measured text.
        const pad = lineH * 0.55;
        const mainPx = lineH * 0.72;
        const subPx = mainPx * 0.82;
        const rows: { text: string; px: number; kind: "history" | "main" | "translated" }[] = [
            ...wrapped.history.map((t) => ({ text: t, px: subPx, kind: "history" as const })),
            ...wrapped.main.map((t) => ({ text: t, px: mainPx, kind: "main" as const })),
            ...wrapped.translated.map((t) => ({ text: t, px: subPx, kind: "translated" as const })),
        ];
        let textW = 0;
        for (const r of rows) {
            ctx.font = this.#font(r);
            textW = Math.max(textW, ctx.measureText(r.text).width);
        }
        const rowH = (r: { px: number }) => r.px * 1.38;
        const want: Size = empty ? { w: this.#cur.w, h: this.#cur.h } : { w: Math.min(textW + pad * 2, MAX_WIDTH_FRAC * W * Math.max(1, s.scale)), h: rows.reduce((a, r) => a + rowH(r), 0) + pad * 1.2 };

        // Morph (critically damped-ish exponential), pop in, fade out.
        const k = this.#cur.w === 0 ? 1 : 1 - Math.exp(-dt / MORPH_TAU);
        this.#cur = { w: this.#cur.w + (want.w - this.#cur.w) * k, h: this.#cur.h + (want.h - this.#cur.h) * k };
        const targetA = empty ? 0 : 1;
        this.#alpha += (targetA - this.#alpha) * (1 - Math.exp(-dt / FADE_TAU));
        this.#pop = empty ? Math.max(0, this.#pop - dt * 4) : Math.min(1, this.#pop + dt * 5);
        if (this.#alpha < 0.01 && empty) {
            this.#mesh.visible = false;
            // Nothing on screen: the preview handles fall back to the settings position.
            this.rect = { u: s.u, v: s.v, w: 0, h: 0 };
            if (this.#alpha < 0.002) this.#cur = { w: 0, h: 0 };
            return;
        }
        this.#mesh.visible = true;

        // Canvas scale: the pill at up to 1.5x output px, fitted inside the texture.
        const r = Math.min(1.5, (CW - 8) / Math.max(this.#cur.w, 1), (CH - 8) / Math.max(this.#cur.h, 1));
        const key = `${rows.map((x) => `${x.kind}:${x.text}`).join("|")}#${Math.round(this.#cur.w)}x${Math.round(this.#cur.h)}#${s.style}`;
        if (key !== this.#drawn && nowMs - this.#lastDraw >= REDRAW_MS) {
            this.#draw(rows, r, pad, rowH);
            this.#drawn = key;
            this.#lastDraw = nowMs;
        }

        // Pop: overshooting scale 0.92 -> 1 (ease-out back); placement clamped inside the frame.
        const p = this.#pop;
        const popScale = 0.92 + 0.08 * (1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2));
        const pw = this.#cur.w / W;
        const ph = this.#cur.h / H;
        const c = clampCentre(s.u, s.v, pw, ph);
        this.rect = { u: c.u, v: c.v, w: pw, h: ph };
        const quadW = (CW / r / W) * popScale;
        const quadH = (CH / r / H) * popScale;
        this.#u.centre.value.set(c.u * 2 - 1, 1 - c.v * 2);
        this.#u.size.value.set(quadW * 2, quadH * 2);
        this.#u.opacity.value = this.#alpha;
    }

    #font(r: { px: number; kind: string }, scale = 1): string {
        const px = Math.round(r.px * scale);
        const weight = r.kind === "main" ? 650 : r.kind === "translated" ? 550 : 500;
        const italic = r.kind === "translated" ? "italic " : "";
        return `${italic}${weight} ${px}px ${FONT}, ${EMOJI}`;
    }

    #draw(rows: readonly { text: string; px: number; kind: "history" | "main" | "translated" }[], r: number, pad: number, rowH: (x: { px: number }) => number): void {
        const ctx = this.#ctx;
        const look = captionLook(this.#settings.style);
        ctx.clearRect(0, 0, CW, CH);
        const w = this.#cur.w * r;
        const h = this.#cur.h * r;
        const x = (CW - w) / 2;
        const y = (CH - h) / 2;
        const radius = Math.min(h / 2, pad * r * 1.1);
        ctx.save();
        if (look.bg !== "rgba(0,0,0,0)") {
            ctx.shadowColor = "rgba(0,0,0,0.35)";
            ctx.shadowBlur = 18 * r;
            ctx.shadowOffsetY = 4 * r;
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, radius);
            ctx.fillStyle = look.bg;
            ctx.fill();
            ctx.shadowColor = "transparent";
            ctx.lineWidth = 1.5 * r;
            ctx.strokeStyle = look.border;
            ctx.stroke();
        }
        // Text, centred; clipped to the pill so a morph never shows text outside it.
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, radius);
        ctx.clip();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const total = rows.reduce((a, row) => a + rowH(row), 0) * r;
        let cy = CH / 2 - total / 2;
        for (const row of rows) {
            const rh = rowH(row) * r;
            ctx.font = this.#font(row, r);
            if (look.shadow) {
                ctx.shadowColor = "rgba(0,0,0,0.85)";
                ctx.shadowBlur = 6 * r;
                ctx.shadowOffsetY = 1.5 * r;
            }
            ctx.fillStyle = row.kind === "main" ? look.text : row.kind === "translated" ? look.accent : look.dim;
            ctx.fillText(row.text, CW / 2, cy + rh / 2);
            cy += rh;
        }
        ctx.restore();
        this.#texture.needsUpdate = true;
    }

    dispose(): void {
        this.setLive(false);
        this.#mesh.removeFromParent();
        this.#mesh.geometry.dispose();
        (this.#mesh.material as THREE.Material).dispose();
        this.#texture.dispose();
    }
}
