import type { ArObject } from "@tiksee/core";
import { PET_IDS, toNodeMaterials, type Backdrop, type LoadedModel, type PetId, type PetStage } from "@tiksee/pets";
import * as THREE from "three/webgpu";
import { float, max, output, screenUV, texture, uniform, vec4 } from "three/tsl";

/**
 * Nominal vertical field of view of the OUTPUT frame. A phone/ZV-E10 at 16 mm
 * equivalent on a portrait crop sits around 55-65°; 60° keeps placed objects
 * believable without calibration. focalPx = (H / 2) / tan(fov / 2).
 */
export const NOMINAL_VFOV_DEG = 60;
/** Distance band where the in-front/behind decision does not flip. */
export const OCCLUSION_HYSTERESIS_M = 0.1;
export const OCCLUSION_FADE_MS = 150;

export function focalPx(outH: number, vfovDeg = NOMINAL_VFOV_DEG): number {
    return outH / 2 / Math.tan((vfovDeg * Math.PI) / 360);
}

/** On-screen height (px) of something `sizeM` tall at `zM` metres. */
export function pixelHeight(sizeM: number, zM: number, outH: number, vfovDeg = NOMINAL_VFOV_DEG): number {
    return (sizeM * focalPx(outH, vfovDeg)) / Math.max(zM, 0.05);
}

/**
 * Whether the person is in front of the object, with hysteresis: it flips to
 * "in front" only once the person is 0.1 m closer than the object, and back
 * only once 0.1 m farther. Unknown distance keeps the previous decision.
 */
export function personInFront(prev: boolean, personM: number | undefined, objectM: number, band = OCCLUSION_HYSTERESIS_M): boolean {
    if (personM === undefined || !Number.isFinite(personM)) return prev;
    if (prev) return personM < objectM + band;
    return personM < objectM - band;
}

/** Linear crossfade toward `target` (0/1) over `fadeMs`. */
export function fadeToward(value: number, target: number, dtMs: number, fadeMs = OCCLUSION_FADE_MS): number {
    const step = dtMs / Math.max(fadeMs, 1);
    return target > value ? Math.min(target, value + step) : Math.max(target, value - step);
}

/** Body anchors in output-normalised coords (y down), null when not seen. */
export type Anchors = Partial<Record<Exclude<ArObject["anchor"], "world">, [number, number]>>;

function animate(o: ArObject, tSec: number): { dx: number; dy: number; rot: number; scale: number } {
    switch (o.animate) {
        case "bob":
            return { dx: 0, dy: Math.sin(tSec * 2) * 0.04, rot: 0, scale: 1 };
        case "spin":
            return { dx: 0, dy: 0, rot: tSec * 1.2, scale: 1 };
        case "pulse":
            return { dx: 0, dy: 0, rot: 0, scale: 1 + Math.sin(tSec * 4) * 0.06 };
        default:
            return { dx: 0, dy: 0, rot: 0, scale: 1 };
    }
}

function canvasFor(o: ArObject): HTMLCanvasElement {
    const c = document.createElement("canvas");
    const g = c.getContext("2d");
    if (o.kind === "emoji") {
        c.width = c.height = 256;
        if (g) {
            g.font = `200px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(o.content, 128, 140);
        }
        return c;
    }
    const lines = o.content.split("\n").slice(0, 6);
    const font = `800 96px system-ui, "Segoe UI", sans-serif`;
    c.width = 1024;
    c.height = 128;
    if (g) {
        g.font = font;
        const w = Math.max(...lines.map((l) => g.measureText(l).width), 64);
        c.width = Math.min(2048, Math.ceil(w + 64));
        c.height = 32 + lines.length * 112;
        g.font = font;
        g.textAlign = "center";
        g.textBaseline = "top";
        g.lineWidth = 12;
        g.strokeStyle = "rgba(0,0,0,0.7)";
        g.fillStyle = "#ffffff";
        lines.forEach((l, i) => {
            g.strokeText(l, c.width / 2, 16 + i * 112);
            g.fillText(l, c.width / 2, 16 + i * 112);
        });
    }
    return c;
}

type FloatUniform = THREE.UniformNode<"float", number>;

interface Placed {
    obj: ArObject;
    key: string;
    root: THREE.Object3D;
    /** Model-space height (quads: 1; models: glb height). */
    height: number;
    aspect: number;
    inFront: boolean;
    /** Uniform: 0 = object over person, 1 = person over object (crossfaded). */
    front: FloatUniform;
    z: FloatUniform;
    dispose(): void;
    mixer?: THREE.AnimationMixer;
    /** Last drawn screen rect, output px, for picking. */
    rect: { x: number; y: number; w: number; h: number; visible: boolean };
}

/**
 * AR objects placed in depth over the camera. Each material multiplies its
 * alpha by (1 - occlusion) where occlusion = mask(uv) when the person is in
 * front (body-scale distance, hysteresis + crossfade), or — with a depth map —
 * per pixel where the scene depth is nearer than the object.
 */
export class ArLayer {
    readonly #scene: THREE.Scene;
    readonly #backdrop: Backdrop;
    readonly #stage: PetStage;
    readonly #placed = new Map<string, Placed>();
    readonly #onError: (m: string) => void;
    readonly #loading = new Set<string>();

    constructor(scene: THREE.Scene, backdrop: Backdrop, stage: PetStage, onError: (m: string) => void) {
        this.#scene = scene;
        this.#backdrop = backdrop;
        this.#stage = stage;
        this.#onError = onError;
    }

    /** Alpha factor node: 1 - occlusion at this fragment. */
    #visibility(front: FloatUniform, z: FloatUniform): THREE.Node<"float"> {
        const mask = this.#backdrop.maskAt(screenUV);
        const nearer = this.#backdrop.personDepthAt(screenUV).lessThan(z).select(float(1), float(0));
        const occ = this.#backdrop.hasDepthNode.greaterThan(0.5).select(mask.mul(nearer), mask.mul(front));
        return float(1).sub(occ);
    }

    #key(o: ArObject): string {
        return `${o.kind}:${o.content.length}:${o.content.slice(0, 64)}`;
    }

    /** Sync the placed objects with settings (adds, removes, rebuilds changed content). */
    set(objects: readonly ArObject[]): void {
        const ids = new Set(objects.map((o) => o.id));
        for (const [id, p] of this.#placed) {
            if (!ids.has(id)) {
                p.dispose();
                this.#placed.delete(id);
            }
        }
        for (const o of objects) {
            const p = this.#placed.get(o.id);
            const key = this.#key(o);
            if (p && p.key === key) {
                p.obj = o;
                continue;
            }
            p?.dispose();
            this.#placed.delete(o.id);
            if (o.kind === "model") void this.#addModel(o, key);
            else this.#addQuad(o, key);
        }
    }

    #base(o: ArObject, key: string, root: THREE.Object3D, height: number, aspect: number, dispose: () => void, extra: { front: Placed["front"]; z: Placed["z"]; mixer?: THREE.AnimationMixer }): void {
        root.visible = false;
        this.#scene.add(root);
        this.#placed.set(o.id, {
            obj: o,
            key,
            root,
            height,
            aspect,
            inFront: false,
            front: extra.front,
            z: extra.z,
            ...(extra.mixer ? { mixer: extra.mixer } : {}),
            rect: { x: 0, y: 0, w: 0, h: 0, visible: false },
            dispose: () => {
                root.removeFromParent();
                dispose();
            },
        });
    }

    #addQuad(o: ArObject, key: string): void {
        const front = uniform(0);
        const z = uniform(o.z);
        let tex: THREE.Texture;
        let aspect = 1;
        if (o.kind === "image") {
            const img = new Image();
            const t = new THREE.Texture(img);
            img.onload = () => {
                t.needsUpdate = true;
                const p = this.#placed.get(o.id);
                if (p) p.aspect = img.naturalWidth / Math.max(img.naturalHeight, 1);
            };
            img.onerror = () => this.#onError(`ar image ${o.name}: failed to decode`);
            img.src = o.content;
            tex = t;
        } else {
            const c = canvasFor(o);
            aspect = c.width / c.height;
            tex = new THREE.CanvasTexture(c);
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        const t = texture(tex);
        const m = new THREE.MeshBasicNodeMaterial();
        m.colorNode = vec4(t.rgb, t.a.mul(this.#visibility(front, z)));
        m.transparent = true;
        m.depthTest = false;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
        mesh.frustumCulled = false;
        // y-down camera: flip the quad so the texture is upright.
        mesh.scale.y = -1;
        const holder = new THREE.Group();
        holder.add(mesh);
        this.#base(o, key, holder, 1, aspect, () => {
            mesh.geometry.dispose();
            m.dispose();
            tex.dispose();
        }, { front, z });
    }

    async #addModel(o: ArObject, key: string): Promise<void> {
        if (!(PET_IDS as readonly string[]).includes(o.content)) {
            this.#onError(`ar model ${o.name}: unknown model "${o.content}"`);
            return;
        }
        if (this.#loading.has(o.id)) return;
        this.#loading.add(o.id);
        let model: LoadedModel;
        try {
            model = await this.#stage.loadModel(o.content as PetId);
        } catch (e) {
            this.#onError(`ar model ${o.name}: ${String(e)}`);
            return;
        } finally {
            this.#loading.delete(o.id);
        }
        const front = uniform(0);
        const z = uniform(o.z);
        const vis = this.#visibility(front, z);
        toNodeMaterials(model.root, (m) => {
            // NodeMaterial.outputNode is declared as an untyped Node; a material output is always vec4.
            const prev = (m.outputNode ?? output) as THREE.Node<"vec4">;
            m.outputNode = vec4(prev.rgb, max(prev.a, float(0)).mul(vis));
            m.transparent = true;
        });
        this.#base(o, key, model.root, model.height, 1, () => model.mixer.stopAllAction(), { front, z, mixer: model.mixer });
    }

    /**
     * Place every object for this frame. `personM` = owner distance (body scale
     * or depth), `anchors` in output-normalised coords.
     */
    update(outW: number, outH: number, personM: number | undefined, anchors: Anchors, tSec: number, dtSec: number, hidden: boolean): void {
        for (const p of this.#placed.values()) {
            const o = p.obj;
            let ax = o.x;
            let ay = o.y;
            if (o.anchor !== "world") {
                const a = anchors[o.anchor];
                if (!a) {
                    p.root.visible = false;
                    p.rect.visible = false;
                    continue;
                }
                // Anchored: x/y are an offset around the anchor (0.5, 0.5 = on it).
                ax = a[0] + (o.x - 0.5);
                ay = a[1] + (o.y - 0.5);
            }
            const anim = animate(o, tSec);
            const hPx = pixelHeight(o.size, o.z, outH) * anim.scale;
            const wPx = hPx * p.aspect;
            const cx = ax * outW;
            const cy = (ay + anim.dy * (o.size / Math.max(o.z, 0.3))) * outH;
            p.root.visible = o.visible && !hidden;
            p.root.position.set(cx, cy, -o.z);
            const s = hPx / p.height;
            p.root.scale.set(o.kind === "model" ? s : wPx, s, o.kind === "model" ? s : 1);
            p.root.rotation.set(0, o.kind === "model" ? anim.rot : 0, ((o.rotation * Math.PI) / 180) + (o.kind === "model" ? 0 : anim.rot));
            // Far objects draw first.
            p.root.renderOrder = 100 - o.z * 10;
            p.inFront = personInFront(p.inFront, personM, o.z);
            p.front.value = fadeToward(p.front.value, p.inFront ? 1 : 0, dtSec * 1000);
            p.z.value = o.z;
            p.mixer?.update(dtSec);
            p.rect = { x: cx - wPx / 2, y: cy - hPx / 2, w: wPx, h: hPx, visible: p.root.visible };
        }
    }

    /** Topmost (nearest) visible object under an output-normalised point. */
    pick(x: number, y: number, outW: number, outH: number): string | null {
        let best: Placed | null = null;
        const px = x * outW;
        const py = y * outH;
        for (const p of this.#placed.values()) {
            const r = p.rect;
            if (!r.visible || px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
            if (!best || p.obj.z < best.obj.z) best = p;
        }
        return best?.obj.id ?? null;
    }

    dispose(): void {
        for (const p of this.#placed.values()) p.dispose();
        this.#placed.clear();
    }
}
