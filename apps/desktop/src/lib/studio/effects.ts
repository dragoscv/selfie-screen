import type { AR_EFFECTS } from "@tiksee/core";
import * as THREE from "three/webgpu";
import { float, floor, instancedBufferAttribute, mod, texture, uv, vec2, vec4 } from "three/tsl";

export type ArEffect = (typeof AR_EFFECTS)[number];

/** Hard cap across every live burst (GPU-cheap: one instanced draw). */
export const MAX_PARTICLES = 400;

/** 4x4 glyph atlas, row-major from the top-left. */
export const GLYPHS = ["❤️", "🎉", "✨", "💋", "🔥", "⭐", "❓", "😮", "3", "2", "1", "💖", "🎊", "🌟", "💕", "■"] as const;
const ATLAS_CELLS = 4;
const G = (g: (typeof GLYPHS)[number]): number => GLYPHS.indexOf(g);

interface BurstSpec {
    cells: number[];
    count: number;
    /** Lifetime range, s. */
    life: [number, number];
    /** Initial speed range, m/s at the burst depth. */
    speed: [number, number];
    /** Direction: "up" cone or "radial". */
    dir: "up" | "radial";
    /** m/s², positive = down. */
    gravity: number;
    /** Glyph height range, m. */
    size: [number, number];
    spin: number;
}

const SPECS: Readonly<Record<Exclude<ArEffect, "countdown">, BurstSpec>> = {
    hearts: { cells: [G("❤️"), G("💖"), G("💕")], count: 18, life: [1.8, 2.8], speed: [0.25, 0.5], dir: "up", gravity: -0.15, size: [0.05, 0.09], spin: 0.6 },
    confetti: { cells: [G("■"), G("🎊"), G("🎉")], count: 70, life: [1.6, 2.6], speed: [0.6, 1.2], dir: "radial", gravity: 0.9, size: [0.02, 0.04], spin: 6 },
    sparkle: { cells: [G("✨"), G("🌟")], count: 30, life: [1.5, 2.2], speed: [0.2, 0.6], dir: "radial", gravity: 0, size: [0.03, 0.06], spin: 2 },
    kiss: { cells: [G("💋")], count: 8, life: [1.6, 2.4], speed: [0.2, 0.4], dir: "up", gravity: -0.1, size: [0.06, 0.1], spin: 0.8 },
    fire: { cells: [G("🔥")], count: 36, life: [1.5, 2.2], speed: [0.3, 0.6], dir: "up", gravity: -0.4, size: [0.04, 0.08], spin: 0.4 },
    stars: { cells: [G("⭐"), G("🌟")], count: 24, life: [1.6, 2.6], speed: [0.4, 0.8], dir: "radial", gravity: 0.3, size: [0.03, 0.06], spin: 3 },
    question: { cells: [G("❓")], count: 6, life: [1.8, 2.6], speed: [0.1, 0.3], dir: "up", gravity: -0.05, size: [0.06, 0.12], spin: 0.5 },
    wow: { cells: [G("😮")], count: 5, life: [1.8, 2.6], speed: [0.1, 0.25], dir: "up", gravity: -0.05, size: [0.08, 0.14], spin: 0.3 },
};

/** Particle state in output pixels (y down), structure-of-arrays, no per-frame allocation. */
export class ParticleField {
    readonly x = new Float32Array(MAX_PARTICLES);
    readonly y = new Float32Array(MAX_PARTICLES);
    readonly z = new Float32Array(MAX_PARTICLES);
    readonly vx = new Float32Array(MAX_PARTICLES);
    readonly vy = new Float32Array(MAX_PARTICLES);
    readonly g = new Float32Array(MAX_PARTICLES);
    readonly age = new Float32Array(MAX_PARTICLES);
    readonly life = new Float32Array(MAX_PARTICLES);
    readonly delay = new Float32Array(MAX_PARTICLES);
    readonly size = new Float32Array(MAX_PARTICLES);
    readonly rot = new Float32Array(MAX_PARTICLES);
    readonly vr = new Float32Array(MAX_PARTICLES);
    readonly cell = new Float32Array(MAX_PARTICLES);
    /** 1 = countdown numeral: pop-in scale and no motion. */
    readonly pop = new Uint8Array(MAX_PARTICLES);
    count = 0;
    readonly #rand: () => number;
    readonly #columns: Float32Array[];

    constructor(rand: () => number = Math.random) {
        this.#rand = rand;
        this.#columns = [this.x, this.y, this.z, this.vx, this.vy, this.g, this.age, this.life, this.delay, this.size, this.rot, this.vr, this.cell];
    }

    #add(): number {
        if (this.count < MAX_PARTICLES) return this.count++;
        // Full: recycle the oldest live particle so new bursts still show.
        let oldest = 0;
        for (let i = 1; i < this.count; i++) if ((this.age[i] ?? 0) / (this.life[i] ?? 1) > (this.age[oldest] ?? 0) / (this.life[oldest] ?? 1)) oldest = i;
        return oldest;
    }

    /**
     * Spawn a burst at output pixel (x, y). `pxPerM` converts metres at the
     * burst depth to pixels; `zM` is kept for draw ordering.
     */
    spawn(effect: ArEffect, x: number, y: number, pxPerM: number, zM: number): void {
        const r = this.#rand;
        const lerp = (a: [number, number]): number => a[0] + (a[1] - a[0]) * r();
        if (effect === "countdown") {
            [G("3"), G("2"), G("1")].forEach((cell, k) => {
                const i = this.#add();
                this.#init(i, x, y - 0.12 * pxPerM, zM, 0, 0, 0, 1, k, 0.3 * pxPerM, 0, 0, cell);
                this.pop[i] = 1;
            });
            return;
        }
        const s = SPECS[effect];
        for (let n = 0; n < s.count; n++) {
            const i = this.#add();
            const speed = lerp(s.speed) * pxPerM;
            const a = s.dir === "up" ? -Math.PI / 2 + (r() - 0.5) * 1.2 : r() * Math.PI * 2;
            const cell = s.cells[Math.floor(r() * s.cells.length)] ?? 0;
            const jitter = 0.04 * pxPerM;
            this.#init(
                i,
                x + (r() - 0.5) * jitter,
                y + (r() - 0.5) * jitter,
                zM,
                Math.cos(a) * speed,
                Math.sin(a) * speed,
                s.gravity * pxPerM,
                lerp(s.life),
                0,
                lerp(s.size) * pxPerM,
                r() * Math.PI * 2,
                (r() - 0.5) * s.spin,
                cell,
            );
            this.pop[i] = 0;
        }
    }

    #init(
        i: number,
        x: number,
        y: number,
        z: number,
        vx: number,
        vy: number,
        g: number,
        life: number,
        delay: number,
        size: number,
        rot: number,
        vr: number,
        cell: number,
    ): void {
        this.x[i] = x;
        this.y[i] = y;
        this.z[i] = z;
        this.vx[i] = vx;
        this.vy[i] = vy;
        this.g[i] = g;
        this.age[i] = 0;
        this.life[i] = life;
        this.delay[i] = delay;
        this.size[i] = size;
        this.rot[i] = rot;
        this.vr[i] = vr;
        this.cell[i] = cell;
    }

    #swap(i: number, j: number): void {
        for (const a of this.#columns) a[i] = a[j] ?? 0;
        this.pop[i] = this.pop[j] ?? 0;
    }

    step(dt: number): void {
        for (let i = 0; i < this.count; ) {
            const d = this.delay[i] ?? 0;
            if (d > 0) {
                this.delay[i] = d - dt;
                i++;
                continue;
            }
            const age = (this.age[i] ?? 0) + dt;
            if (age >= (this.life[i] ?? 0)) {
                this.count--;
                if (i !== this.count) this.#swap(i, this.count);
                continue;
            }
            this.age[i] = age;
            this.vy[i] = (this.vy[i] ?? 0) + (this.g[i] ?? 0) * dt;
            this.x[i] = (this.x[i] ?? 0) + (this.vx[i] ?? 0) * dt;
            this.y[i] = (this.y[i] ?? 0) + (this.vy[i] ?? 0) * dt;
            this.rot[i] = (this.rot[i] ?? 0) + (this.vr[i] ?? 0) * dt;
            i++;
        }
    }

    /** Fade in 0.1 s, out over the last 30 %; countdown numerals pop in. Returns [alpha, scale]. */
    look(i: number): [number, number] {
        if ((this.delay[i] ?? 0) > 0) return [0, 0];
        const t = (this.age[i] ?? 0) / Math.max(this.life[i] ?? 1, 1e-3);
        const fadeIn = Math.min((this.age[i] ?? 0) / 0.1, 1);
        const fadeOut = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
        const scale = this.pop[i] ? 0.6 + 0.4 * Math.min(t / 0.25, 1) + 0.2 * Math.max(0, 1 - Math.abs(t - 0.25) * 8) : 1;
        return [fadeIn * fadeOut, scale];
    }
}

function atlasTexture(): THREE.CanvasTexture {
    const cell = 128;
    const c = document.createElement("canvas");
    c.width = c.height = cell * ATLAS_CELLS;
    const g = c.getContext("2d");
    if (g) {
        g.textAlign = "center";
        g.textBaseline = "middle";
        GLYPHS.forEach((glyph, i) => {
            const cx = (i % ATLAS_CELLS) * cell + cell / 2;
            const cy = Math.floor(i / ATLAS_CELLS) * cell + cell / 2;
            if (glyph === "■") {
                g.fillStyle = `hsl(${(i * 47) % 360} 90% 60%)`;
                g.fillRect(cx - cell * 0.3, cy - cell * 0.18, cell * 0.6, cell * 0.36);
                return;
            }
            const numeral = /^\d$/.test(glyph);
            g.font = numeral ? `900 ${cell * 0.85}px system-ui, sans-serif` : `${cell * 0.78}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
            if (numeral) {
                g.lineWidth = cell * 0.08;
                g.strokeStyle = "rgba(0,0,0,0.75)";
                g.strokeText(glyph, cx, cy);
                g.fillStyle = "#ffffff";
            }
            g.fillText(glyph, cx, cy);
        });
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
}

/** One instanced draw for every particle, in the pixel-space AR scene. */
export class EffectLayer {
    readonly field: ParticleField;
    readonly #mesh: THREE.InstancedMesh;
    readonly #cell: THREE.InstancedBufferAttribute;
    readonly #alpha: THREE.InstancedBufferAttribute;
    readonly #atlas: THREE.CanvasTexture;

    constructor(scene: THREE.Scene, field = new ParticleField()) {
        this.field = field;
        this.#atlas = atlasTexture();
        this.#cell = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
        this.#alpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
        this.#cell.setUsage(THREE.DynamicDrawUsage);
        this.#alpha.setUsage(THREE.DynamicDrawUsage);
        const cell = instancedBufferAttribute<"float">(this.#cell, "float");
        const alpha = instancedBufferAttribute<"float">(this.#alpha, "float");
        const col = mod(cell, float(ATLAS_CELLS));
        const row = floor(cell.div(ATLAS_CELLS));
        const p = uv();
        // Atlas is flipY: the top canvas row is v = 1.
        const cuv = vec2(col.add(p.x).div(ATLAS_CELLS), float(1).sub(row.add(float(1).sub(p.y)).div(ATLAS_CELLS)));
        const tex = texture(this.#atlas, cuv);
        const m = new THREE.MeshBasicNodeMaterial();
        m.colorNode = vec4(tex.rgb, tex.a.mul(alpha));
        m.transparent = true;
        m.depthTest = false;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
        this.#mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), m, MAX_PARTICLES);
        this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.#mesh.frustumCulled = false;
        this.#mesh.renderOrder = 1000;
        this.#mesh.count = 0;
        scene.add(this.#mesh);
    }

    spawn(effect: ArEffect, x: number, y: number, pxPerM: number, zM: number): void {
        this.field.spawn(effect, x, y, pxPerM, zM);
    }

    update(dt: number): void {
        const f = this.field;
        f.step(dt);
        const m = this.#mesh.instanceMatrix.array as Float32Array;
        const cells = this.#cell.array as Float32Array;
        const alphas = this.#alpha.array as Float32Array;
        for (let i = 0; i < f.count; i++) {
            const [a, k] = f.look(i);
            const s = (f.size[i] ?? 0) * k;
            const c = Math.cos(f.rot[i] ?? 0) * s;
            const sn = Math.sin(f.rot[i] ?? 0) * s;
            const o = i * 16;
            // Column-major TRS; y scale negated for the y-down pixel camera.
            m[o] = c;
            m[o + 1] = sn;
            m[o + 2] = 0;
            m[o + 3] = 0;
            m[o + 4] = sn;
            m[o + 5] = -c;
            m[o + 6] = 0;
            m[o + 7] = 0;
            m[o + 8] = 0;
            m[o + 9] = 0;
            m[o + 10] = 1;
            m[o + 11] = 0;
            m[o + 12] = f.x[i] ?? 0;
            m[o + 13] = f.y[i] ?? 0;
            m[o + 14] = 100;
            m[o + 15] = 1;
            cells[i] = f.cell[i] ?? 0;
            alphas[i] = a;
        }
        this.#mesh.count = f.count;
        this.#mesh.visible = f.count > 0;
        this.#mesh.instanceMatrix.needsUpdate = true;
        this.#cell.needsUpdate = true;
        this.#alpha.needsUpdate = true;
    }

    dispose(): void {
        this.#mesh.removeFromParent();
        this.#mesh.geometry.dispose();
        (this.#mesh.material as THREE.Material).dispose();
        this.#atlas.dispose();
    }
}
