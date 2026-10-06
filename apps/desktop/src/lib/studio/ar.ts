import type { ArObject } from "@tiksee/core";
import {
    fadeToward,
    personInFront,
    PET_IDS,
    pixelsAt,
    project,
    toNodeMaterials,
    unproject,
    type Backdrop,
    type LoadedModel,
    type PetId,
    type PetStage,
    type Pinhole,
} from "@tiksee/pets";
import * as THREE from "three/webgpu";
import { float, max, output, screenUV, texture, uniform, vec4 } from "three/tsl";

export { fadeToward, OCCLUSION_FADE_MS, OCCLUSION_HYSTERESIS_M, personInFront } from "@tiksee/pets";

/**
 * Nominal vertical field of view of the OUTPUT frame. A phone/ZV-E10 at 16 mm
 * equivalent on a portrait crop sits around 55-65°; 60° keeps placed objects
 * believable without calibration. focalPx = (H / 2) / tan(fov / 2).
 */
export const NOMINAL_VFOV_DEG = 60;

export function focalPx(outH: number, vfovDeg = NOMINAL_VFOV_DEG): number {
    return outH / 2 / Math.tan((vfovDeg * Math.PI) / 360);
}

/** On-screen height (px) of something `sizeM` tall at `zM` metres. */
export function pixelHeight(sizeM: number, zM: number, outH: number, vfovDeg = NOMINAL_VFOV_DEG): number {
    return pixelsAt({ width: outH, height: outH, vfovDeg }, sizeM, zM);
}

/** Body anchors in output-normalised coords (y down), null when not seen. */
export type Anchors = Partial<Record<Exclude<ArObject["anchor"], "world">, [number, number]>>;

/** Per-frame animation: `dy` is a vertical offset in object heights (+ = up). */
function animate(o: ArObject, tSec: number): { dy: number; rot: number; scale: number } {
    switch (o.animate) {
        case "bob":
            return { dy: Math.sin(tSec * 2) * 0.04, rot: 0, scale: 1 };
        case "spin":
            return { dy: 0, rot: tSec * 1.2, scale: 1 };
        case "pulse":
            return { dy: 0, rot: 0, scale: 1 + Math.sin(tSec * 4) * 0.06 };
        default:
            return { dy: 0, rot: 0, scale: 1 };
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
    /** Last drawn screen rect, output-normalised (y down), for picking. */
    rect: { x: number; y: number; w: number; h: number; visible: boolean };
}

/**
 * AR objects placed in world metres (camera frame, +Y up, -Z forward). Each
 * material multiplies its alpha by (1 - occlusion) where occlusion = mask(uv)
 * when the person is in front (body-scale distance, hysteresis + crossfade),
 * or — with a depth map — per pixel where the scene depth is nearer than the
 * object. Objects depth-test against the pets.
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
        m.depthTest = true;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
        mesh.frustumCulled = false;
        // y-up world + flipY textures: the plane renders upright as is.
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
            m.depthWrite = true;
        });
        this.#base(o, key, model.root, model.height, 1, () => model.mixer.stopAllAction(), { front, z, mixer: model.mixer });
    }

    #pin: Pinhole | null = null;

    /**
     * Place every object for this frame in world metres. `pin` = the output
     * camera, `personM` = owner distance (body scale or depth), `anchors` in
     * output-normalised coords (y down).
     */
    update(pin: Pinhole, personM: number | undefined, anchors: Anchors, tSec: number, dtSec: number, hidden: boolean): void {
        this.#pin = pin;
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
            const sizeM = o.size * anim.scale;
            const [wx, wy, wz] = unproject(pin, ax, ay, o.z);
            p.root.visible = o.visible && !hidden;
            p.root.position.set(wx, wy + anim.dy * o.size, wz);
            const roll = (o.rotation * Math.PI) / 180;
            if (o.kind === "model") {
                // glTF model: Y up, facing +Z (towards the camera), feet at the origin.
                const s = sizeM / Math.max(p.height, 1e-6);
                p.root.scale.set(s, s, s);
                p.root.rotation.set(0, anim.rot, roll);
            } else {
                    // Billboard: parallel to the image plane (the camera's pitch), then roll on screen.
                p.root.scale.set(sizeM * p.aspect, sizeM, 1);
                    p.root.rotation.set((-(pin.tiltDeg ?? 0) * Math.PI) / 180, 0, roll + anim.rot, "YXZ");
            }
            // Depth test handles correctness; this only sorts transparent draws.
            p.root.renderOrder = 100 - o.z * 10;
            p.inFront = personInFront(p.inFront, personM, o.z);
            p.front.value = fadeToward(p.front.value, p.inFront ? 1 : 0, dtSec * 1000);
            p.z.value = o.z;
            p.mixer?.update(dtSec);
            const c = project(pin, [p.root.position.x, p.root.position.y, p.root.position.z]);
            const hN = pixelsAt(pin, sizeM, o.z) / Math.max(pin.height, 1);
            const wN = (pixelsAt(pin, sizeM * p.aspect, o.z) / Math.max(pin.width, 1));
            // Models stand on their origin (feet): their box extends upward.
            const cy = o.kind === "model" ? c.v - hN / 2 : c.v;
            p.rect = { x: c.u - wN / 2, y: cy - hN / 2, w: wN, h: hN, visible: p.root.visible };
        }
    }

    /** Topmost (nearest) visible object under an output-normalised point. */
    pick(x: number, y: number, outW: number, outH: number): string | null {
        if (!this.#pin) return null;
        let best: Placed | null = null;
        const px = x * outW;
        const py = y * outH;
        for (const p of this.#placed.values()) {
            const r = p.rect;
            if (!r.visible || px < r.x * outW || px > (r.x + r.w) * outW || py < r.y * outH || py > (r.y + r.h) * outH) continue;
            if (!best || p.obj.z < best.obj.z) best = p;
        }
        return best?.obj.id ?? null;
    }

    dispose(): void {
        for (const p of this.#placed.values()) p.dispose();
        this.#placed.clear();
    }
}
