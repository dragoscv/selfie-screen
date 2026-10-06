import * as THREE from "three/webgpu";
import { acesFilmicToneMapping, float, output, vec4 } from "three/tsl";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

import { petPixelHeight, petUrl, type PetId } from "./catalogue.js";
import type { ShoulderAnchor, Side } from "./shoulders.js";
import { PetStateMachine, type PetClip, type PetEvent } from "./state-machine.js";
import { MOUTH_SHAPES, mouthWeights, type VisemeEvent } from "./visemes.js";

export interface StageOptions {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    /** Base URL serving <pet>.glb. */
    assetBase: string;
    /** Where the KTX2 (Basis) transcoder wasm lives. */
    transcoderPath: string;
    /** Force the WebGL2 backend (the overlay fallback path, Q33). */
    forceWebGL?: boolean;
    /** MSAA on the canvas. Off when the stage renders into its own multisampled targets. */
    antialias?: boolean;
    /**
     * Compositor mode: the renderer does no output transform (no tone mapping,
     * linear output) and pet materials apply ACES themselves, so a later
     * composite pass can put them over an untouched camera image.
     */
    inlineToneMapping?: boolean;
}

interface Slot {
    pet: PetId;
    root: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    actions: Map<string, THREE.AnimationAction>;
    current: THREE.AnimationAction | null;
    morphs: { mesh: THREE.Mesh; index: number[] }[];
    brain: PetStateMachine;
    /** Model-space height of the loaded glb, for pixel scaling. */
    modelHeight: number;
}

/**
 * Replace classic materials under `root` with node materials (the same copy
 * three's NodeLibrary does) and let `edit` add nodes to each. Shared materials
 * are converted once.
 */
export function toNodeMaterials(root: THREE.Object3D, edit: (m: THREE.NodeMaterial) => void): void {
    const done = new Map<THREE.Material, THREE.NodeMaterial>();
    const convert = (m: THREE.Material): THREE.NodeMaterial => {
        const hit = done.get(m);
        if (hit) return hit;
        let nm: THREE.NodeMaterial;
        if ((m as THREE.NodeMaterial).isNodeMaterial) nm = m as THREE.NodeMaterial;
        else {
            nm =
                m.type === "MeshPhysicalMaterial"
                    ? new THREE.MeshPhysicalNodeMaterial()
                    : m.type === "MeshBasicMaterial"
                      ? new THREE.MeshBasicNodeMaterial()
                      : new THREE.MeshStandardNodeMaterial();
            const src = m as unknown as Record<string, unknown>;
            const dst = nm as unknown as Record<string, unknown>;
            for (const key in src) if (key !== "type" && key !== "uuid") dst[key] = src[key];
        }
        edit(nm);
        nm.needsUpdate = true;
        done.set(m, nm);
        return nm;
    };
    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    });
}

/** ACES filmic on the material's own output (what the renderer would do on screen). */
export function inlineAces(m: THREE.NodeMaterial): void {
    // The tone-mapping helpers are declared as returning an untyped Node; they return the input's vec3.
    const mapped = acesFilmicToneMapping(output.rgb, float(1)) as THREE.Node<"vec3">;
    m.outputNode = vec4(mapped, output.a);
}

/** A pet model loaded for use outside the shoulder slots (AR "model" objects). */
export interface LoadedModel {
    /** y-flipped holder for the pixel-space camera; scale it by `pixels / height`. */
    root: THREE.Object3D;
    height: number;
    mixer: THREE.AnimationMixer;
}

/**
 * Renders pets in output pixel space: an orthographic camera with y down maps
 * shoulder anchors straight onto the scene. One stage per output surface; AR
 * meshes may share `scene` so pets and objects land in one pass.
 */
export class PetStage {
    readonly renderer: THREE.WebGPURenderer;
    readonly scene = new THREE.Scene();
    readonly camera: THREE.OrthographicCamera;
    readonly #o: StageOptions;
    readonly #slots = new Map<Side, Slot>();
    #loader: GLTFLoader | null = null;
    #speech: { visemes: readonly VisemeEvent[]; startMs: number } | null = null;
    #hidden = false;

    constructor(options: StageOptions) {
        this.#o = options;
        this.renderer = new THREE.WebGPURenderer({
            canvas: options.canvas,
            alpha: true,
            antialias: options.antialias ?? true,
            forceWebGL: options.forceWebGL ?? false,
        });
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.setSize(options.width, options.height, false);
        if (options.inlineToneMapping) {
            this.renderer.toneMapping = THREE.NoToneMapping;
            this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        } else {
            this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        }
        // Pixel space, y down: top=0, bottom=height. Depth range covers pet bodies.
        this.camera = new THREE.OrthographicCamera(0, options.width, 0, options.height, -2000, 2000);
        this.camera.position.z = 1000;
        const key = new THREE.DirectionalLight(0xffffff, 2.4);
        key.position.set(-0.4, -0.8, 1);
        const rim = new THREE.DirectionalLight(0xbfd8ff, 1.2);
        rim.position.set(0.6, -0.3, -0.8);
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1), key, rim);
    }

    async init(): Promise<void> {
        await this.renderer.init();
        const ktx2 = new KTX2Loader().setTranscoderPath(this.#o.transcoderPath).detectSupport(this.renderer);
        this.#loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    }

    /**
     * True when a WebGPU adapter answers within `timeoutMs`. Some Chromium
     * embeddings expose `navigator.gpu` but never settle `requestAdapter()`
     * (measured: VS Code's Electron 43 browser), which would hang
     * `renderer.init()` forever; callers then pass `forceWebGL`.
     */
    static async webgpuAvailable(timeoutMs = 2500): Promise<boolean> {
        const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
        if (!gpu) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
        });
        try {
            const adapter = await Promise.race([gpu.requestAdapter().catch(() => null), timeout]);
            return adapter != null;
        } finally {
            clearTimeout(timer);
        }
    }

    get backend(): "webgpu" | "webgl" {
        const b = (this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
        return b?.isWebGPUBackend ? "webgpu" : "webgl";
    }

    get width(): number {
        return this.#o.width;
    }

    get height(): number {
        return this.#o.height;
    }

    resize(width: number, height: number): void {
        this.#o.width = width;
        this.#o.height = height;
        this.renderer.setSize(width, height, false);
        this.camera.right = width;
        this.camera.bottom = height;
        this.camera.updateProjectionMatrix();
    }

    async #load(pet: PetId): Promise<{ holder: THREE.Group; root: THREE.Object3D; gltf: { animations: THREE.AnimationClip[] }; height: number }> {
        if (!this.#loader) throw new Error("PetStage.init() not awaited");
        const gltf = await this.#loader.loadAsync(petUrl(this.#o.assetBase, pet));
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        // glTF is y-up and faces +z; flip y for the y-down pixel camera.
        const holder = new THREE.Group();
        root.scale.y = -1;
        holder.add(root);
        root.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
        });
        if (this.#o.inlineToneMapping) toNodeMaterials(root, inlineAces);
        return { holder, root, gltf, height: Math.max(box.max.y - box.min.y, 1e-3) };
    }

    /** Load a pet glb as a free-standing model (idle clip playing). The caller adds it to a scene. */
    async loadModel(pet: PetId): Promise<LoadedModel> {
        const { holder, root, gltf, height } = await this.#load(pet);
        const mixer = new THREE.AnimationMixer(root);
        const idle = gltf.animations.find((c) => c.name === "idle") ?? gltf.animations[0];
        if (idle) mixer.clipAction(idle).play();
        return { root: holder, height, mixer };
    }

    /** Put `pet` on a shoulder (null removes it). */
    async setPet(side: Side, pet: PetId | null): Promise<void> {
        const old = this.#slots.get(side);
        if (old) {
            this.scene.remove(old.root);
            old.mixer.stopAllAction();
            this.#slots.delete(side);
        }
        if (!pet) return;
        const { holder, root, gltf, height } = await this.#load(pet);
        const mixer = new THREE.AnimationMixer(root);
        const actions = new Map(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]));
        const morphs: Slot["morphs"] = [];
        root.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
                const dict = mesh.morphTargetDictionary;
                morphs.push({ mesh, index: MOUTH_SHAPES.map((s) => dict[`mouth_${s}`] ?? -1) });
            }
        });
        const slot: Slot = {
            pet,
            root: holder,
            mixer,
            actions,
            current: null,
            morphs,
            brain: new PetStateMachine(performance.now()),
            modelHeight: height,
        };
        holder.visible = false;
        this.scene.add(holder);
        this.#slots.set(side, slot);
        this.#play(slot, "idle");
    }

    #play(slot: Slot, clip: PetClip): void {
        const next = slot.actions.get(clip) ?? slot.actions.get("idle");
        if (!next || next === slot.current) return;
        next.reset().setEffectiveWeight(1).play();
        if (slot.current) slot.current.crossFadeTo(next, 0.25, false);
        slot.current = next;
    }

    send(event: PetEvent): void {
        const now = performance.now();
        for (const s of this.#slots.values()) s.brain.send(event, now);
    }

    /** Start lip-sync for an utterance that began playing at `startMs` (performance clock). */
    speak(visemes: readonly VisemeEvent[], startMs = performance.now()): void {
        this.#speech = { visemes, startMs };
        this.send({ type: "speechStart" });
    }

    stopSpeaking(): void {
        this.#speech = null;
        this.send({ type: "speechEnd" });
    }

    setHidden(hidden: boolean): void {
        this.#hidden = hidden;
    }

    /**
     * Advance animation and draw one frame into `target` (null = the canvas),
     * cleared transparent. `anchors` null hides the pets. Pets sit on the
     * owner's shoulders, so their depth is the owner's distance: the shoulder
     * span already scales them for it, and they stay at z = 0 in the scene.
     */
    render(anchors: Record<Side, ShoulderAnchor> | null, dtSec: number, target: THREE.RenderTarget | null = null): void {
        this.update(anchors, dtSec);
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, this.camera);
        this.renderer.setRenderTarget(null);
    }

    /** Advance animation and place the pets without drawing. */
    update(anchors: Record<Side, ShoulderAnchor> | null, dtSec: number): void {
        const now = performance.now();
        const mouth = this.#mouth(now);
        for (const [side, slot] of this.#slots) {
            const a = anchors?.[side];
            slot.root.visible = !this.#hidden && !!a?.visible;
            this.#play(slot, slot.brain.tick(now));
            slot.mixer.update(dtSec);
            if (!a || !slot.root.visible) continue;
            const px = petPixelHeight(slot.pet, a.span) / slot.modelHeight;
            slot.root.position.set(a.x, a.y, 0);
            slot.root.scale.setScalar(px);
            slot.root.rotation.set(0, side === "left" ? -0.35 : 0.35, a.roll);
            for (const m of slot.morphs) {
                const inf = m.mesh.morphTargetInfluences;
                if (!inf) continue;
                m.index.forEach((i, k) => {
                    const shape = MOUTH_SHAPES[k];
                    if (i >= 0 && shape) inf[i] = mouth ? mouth[shape] : k === 0 ? 1 : 0;
                });
            }
        }
    }

    #mouth(now: number): ReturnType<typeof mouthWeights> | null {
        if (!this.#speech) return null;
        const t = now - this.#speech.startMs;
        const last = this.#speech.visemes.at(-1);
        if (last && t > last.offsetMs + 400) {
            this.stopSpeaking();
            return null;
        }
        return mouthWeights(this.#speech.visemes, t);
    }

    dispose(): void {
        for (const side of [...this.#slots.keys()]) void this.setPet(side, null);
        this.renderer.dispose();
    }
}
