import * as THREE from "three/webgpu";
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
 * Renders pets in output pixel space: an orthographic camera with y down maps
 * shoulder anchors straight onto the scene. One stage per output surface.
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
            antialias: true,
            forceWebGL: options.forceWebGL ?? false,
        });
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.setSize(options.width, options.height, false);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
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

    get backend(): "webgpu" | "webgl" {
        const b = (this.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
        return b?.isWebGPUBackend ? "webgpu" : "webgl";
    }

    resize(width: number, height: number): void {
        this.#o.width = width;
        this.#o.height = height;
        this.renderer.setSize(width, height, false);
        this.camera.right = width;
        this.camera.bottom = height;
        this.camera.updateProjectionMatrix();
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
        if (!this.#loader) throw new Error("PetStage.init() not awaited");
        const gltf = await this.#loader.loadAsync(petUrl(this.#o.assetBase, pet));
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        // glTF is y-up and faces +z; flip y for the y-down pixel camera.
        const holder = new THREE.Group();
        root.scale.y = -1;
        holder.add(root);
        const mixer = new THREE.AnimationMixer(root);
        const actions = new Map(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]));
        const morphs: Slot["morphs"] = [];
        root.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
                const dict = mesh.morphTargetDictionary;
                morphs.push({ mesh, index: MOUTH_SHAPES.map((s) => dict[`mouth_${s}`] ?? -1) });
            }
            if (mesh.isMesh) mesh.frustumCulled = false;
        });
        const slot: Slot = {
            pet,
            root: holder,
            mixer,
            actions,
            current: null,
            morphs,
            brain: new PetStateMachine(performance.now()),
            modelHeight: Math.max(box.max.y - box.min.y, 1e-3),
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

    /** Advance animation and draw one frame. `anchors` null hides the pets. */
    render(anchors: Record<Side, ShoulderAnchor> | null, dtSec: number): void {
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
        this.renderer.render(this.scene, this.camera);
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
