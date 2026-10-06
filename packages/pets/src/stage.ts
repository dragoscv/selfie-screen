import * as THREE from "three/webgpu";
import { acesFilmicToneMapping, float, interleavedGradientNoise, length, max, output, screenCoordinate, screenUV, uniform, uv, vec4 } from "three/tsl";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

import type { Backdrop } from "./backdrop.js";
import { PETS, petUrl, type PetId } from "./catalogue.js";
import { fadeToward, personInFront } from "./occlusion.js";
import { PetActor } from "./pet-actor.js";
import { PetRoamer, type AnchorId, type PetPose } from "./roam.js";
import type { Side } from "./shoulders.js";
import { DEFAULT_VFOV_DEG, project, type BodySnapshot, type Pinhole, type Vec3 } from "./space.js";
import type { PetEvent } from "./state-machine.js";
import { mouthWeights, type VisemeEvent } from "./visemes.js";

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

type FloatUniform = THREE.UniformNode<"float", number>;

interface Slot {
    actor: PetActor;
    roamer: PetRoamer;
    /** World metres per model unit. */
    scaleM: number;
    /** 0..1 show/hide fade (hidden by Live Control, or while loading). */
    fade: number;
    /** Occlusion: 1 = person in front of the pet (crossfaded, mask-driven). */
    front: FloatUniform;
    /** Pet depth (m) for per-pixel depth-map occlusion. */
    depth: FloatUniform;
    /** Material alpha (fade). */
    alpha: FloatUniform;
    inFront: boolean;
    shadow: THREE.Mesh;
    shadowAlpha: FloatUniform;
    /** Last pose (debug overlay). */
    pose: PetPose | null;
}

/** What the debug overlay reads per pet. */
export interface PetDebug {
    side: Side;
    pet: PetId;
    pose: PetPose;
    /** Output-normalised screen point of the contact point and its depth. */
    screen: { u: number; v: number; depthM: number };
    personInFront: number;
    animating: boolean;
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
 * The studio's 3D stage. One PERSPECTIVE camera at the world origin looking
 * down -Z, units in METRES, vertical field of view = the output frame's
 * (space.ts). Pets, AR objects and effects live in this one space; the camera
 * backdrop is a clip-space quad (vertexNode), so it fills the frame
 * regardless of the camera.
 *
 * Pets: PetRoamer decides where each pet is (perches on the owner's body,
 * orbits, ledges), PetActor animates it. Occlusion against the owner is per
 * pixel (person mask x in-front decision, or the depth map when present),
 * the same rule as AR objects.
 */
export class PetStage {
    readonly renderer: THREE.WebGPURenderer;
    readonly scene = new THREE.Scene();
    readonly camera: THREE.PerspectiveCamera;
    readonly #o: StageOptions;
    readonly #slots = new Map<Side, Slot>();
    readonly #loading = new Map<Side, PetId | null>();
    #loader: GLTFLoader | null = null;
    #speech: { visemes: readonly VisemeEvent[]; startMs: number } | null = null;
    #hidden = false;
    #vfov = DEFAULT_VFOV_DEG;
    #tilt = 0;
    #camHeight = 0;
    #backdrop: Backdrop | null = null;
    #pointAt: Vec3 | null = null;
    #debug: PetDebug[] = [];

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
        // Metres; near 5 cm, far 20 m. The camera never moves.
        this.camera = new THREE.PerspectiveCamera(this.#vfov, options.width / options.height, 0.05, 20);
        this.camera.position.set(0, 0, 0);
        // Room-like light: key from upper left/front, cool rim from behind, sky/ground fill.
        const key = new THREE.DirectionalLight(0xfff4e8, 2.2);
        key.position.set(-0.6, 1, 0.8);
        const rim = new THREE.DirectionalLight(0xbfd8ff, 1.3);
        rim.position.set(0.7, 0.4, -1);
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4a55, 1.2), key, rim);
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

    /** The output pinhole (for BodyModel / overlays). */
    get pinhole(): Pinhole {
        return { width: this.#o.width, height: this.#o.height, vfovDeg: this.#vfov, tiltDeg: this.#tilt, heightM: this.#camHeight };
    }

    /** Camera mount in the room: pitch down (deg) and lens height above the floor (m). */
    setCameraPose(tiltDeg: number, heightM: number): void {
        if (Math.abs(tiltDeg - this.#tilt) < 1e-3 && Math.abs(heightM - this.#camHeight) < 1e-4) return;
        this.#tilt = tiltDeg;
        this.#camHeight = heightM;
        this.camera.position.set(0, heightM, 0);
        this.camera.rotation.set((-tiltDeg * Math.PI) / 180, 0, 0, "YXZ");
        this.camera.updateMatrixWorld();
    }

    /** Vertical field of view of the OUTPUT frame (after digital zoom). */
    setFov(vfovDeg: number): void {
        if (Math.abs(vfovDeg - this.#vfov) < 1e-3) return;
        this.#vfov = vfovDeg;
        this.camera.fov = vfovDeg;
        this.camera.updateProjectionMatrix();
    }

    /** The camera backdrop whose person mask / depth occlude pets. */
    setBackdrop(backdrop: Backdrop | null): void {
        this.#backdrop = backdrop;
    }

    resize(width: number, height: number): void {
        this.#o.width = width;
        this.#o.height = height;
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / Math.max(height, 1);
        this.camera.updateProjectionMatrix();
    }

    async #load(pet: PetId): Promise<{ root: THREE.Object3D; animations: THREE.AnimationClip[]; height: number }> {
        if (!this.#loader) throw new Error("PetStage.init() not awaited");
        const gltf = await this.#loader.loadAsync(petUrl(this.#o.assetBase, pet));
        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        return { root, animations: gltf.animations, height: Math.max(box.max.y - box.min.y, 1e-3) };
    }

    /** Load a pet glb as a free-standing model (idle clip playing). The caller adds it to a scene and scales it. */
    async loadModel(pet: PetId): Promise<LoadedModel> {
        const { root, animations, height } = await this.#load(pet);
        if (this.#o.inlineToneMapping) toNodeMaterials(root, inlineAces);
        root.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
        });
        const holder = new THREE.Group();
        holder.add(root);
        const mixer = new THREE.AnimationMixer(root);
        const idle = animations.find((c) => c.name === "idle") ?? animations[0];
        if (idle) mixer.clipAction(idle).play();
        return { root: holder, height, mixer };
    }

    /**
     * Occlusion + fade alpha for a material at this fragment: 1 - person
     * coverage (mask x front, or depth-map nearer-than-pet) times the fade.
     * Dithered (interleaved gradient noise) and alpha-tested: correct with
     * depth writes, no sorting artefacts between pet parts.
     */
    #opacity(front: FloatUniform, depth: FloatUniform, alpha: THREE.Node<"float">): THREE.Node<"float"> {
        const b = this.#backdrop;
        if (!b) return alpha;
        const mask = b.maskAt(screenUV);
        const nearer = b.personDepthAt(screenUV).lessThan(depth).select(float(1), float(0));
        const occ = b.hasDepthNode.greaterThan(0.5).select(mask.mul(nearer), mask.mul(front));
        return float(1).sub(occ).mul(alpha);
    }

    /** Put `pet` in the scene for `side` (null removes it). Concurrent calls: the last one wins. */
    async setPet(side: Side, pet: PetId | null): Promise<void> {
        this.#loading.set(side, pet);
        if (!pet) {
            this.#remove(side);
            return;
        }
        if (this.#slots.get(side)?.actor.pet === pet) return;
        const { root, animations, height } = await this.#load(pet);
        // A newer setPet for this side superseded us while loading.
        if (this.#loading.get(side) !== pet) return;
        this.#remove(side);
        const front = uniform(0);
        const depth = uniform(1);
        const alpha = uniform(0);
        const opacity = this.#opacity(front, depth, alpha);
        toNodeMaterials(root, (m) => {
            if (this.#o.inlineToneMapping) inlineAces(m);
            // Dithered alpha: stays opaque (depth-correct between pet parts), fades/occludes without sorting.
            m.maskNode = opacity.greaterThan(interleavedGradientNoise(screenCoordinate.xy).mul(0.98).add(0.01));
            m.transparent = false;
            m.depthWrite = true;
            m.depthTest = true;
        });
        const actor = new PetActor(pet, root, animations, performance.now(), height);
        const scaleM = PETS[pet].heightM / height;
        actor.root.scale.setScalar(scaleM);
        // Contact shadow: a soft procedural ellipse under the feet, same occlusion rule.
        const shadowAlpha = uniform(0);
        const sm = new THREE.MeshBasicNodeMaterial();
        const centre = uv().sub(0.5);
        const soft = float(1).sub(length(centre).mul(2)).clamp(0, 1);
        sm.colorNode = vec4(0, 0, 0, soft.mul(soft).mul(0.45).mul(max(this.#opacity(front, depth, shadowAlpha), float(0))));
        sm.transparent = true;
        sm.depthWrite = false;
        const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sm);
        shadow.rotation.x = -Math.PI / 2;
        shadow.renderOrder = 5;
        shadow.frustumCulled = false;
        this.scene.add(actor.root, shadow);
        const roamer = new PetRoamer({ side, family: PETS[pet].family, heightM: PETS[pet].heightM });
        this.#slots.set(side, { actor, roamer, scaleM, fade: 0, front, depth, alpha, inFront: false, shadow, shadowAlpha, pose: null });
    }

    #remove(side: Side): void {
        const old = this.#slots.get(side);
        if (!old) return;
        old.actor.dispose();
        old.shadow.removeFromParent();
        old.shadow.geometry.dispose();
        (old.shadow.material as THREE.Material).dispose();
        this.#slots.delete(side);
    }

    send(event: PetEvent): void {
        const now = performance.now();
        for (const s of this.#slots.values()) s.actor.send(event, now);
    }

    /** Send pets to an anchor (gestures, gifts): "centre", "orbit", "crown", "point"... */
    goTo(anchor: AnchorId, pointAt: Vec3 | null = null): void {
        if (pointAt) this.#pointAt = pointAt;
        for (const s of this.#slots.values()) s.roamer.request(anchor);
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

    /** Per-pet state for the 3D debug overlay (refreshed every update). */
    get debug(): readonly PetDebug[] {
        return this.#debug;
    }

    /** Pets currently drawn (visible and faded in). */
    get activeCount(): number {
        let n = 0;
        for (const s of this.#slots.values()) if (s.actor.visible) n++;
        return n;
    }

    /**
     * Advance and draw one frame into `target` (null = the canvas).
     */
    render(body: BodySnapshot | null, dtSec: number, target: THREE.RenderTarget | null = null): void {
        this.update(body, dtSec);
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, this.camera);
        this.renderer.setRenderTarget(null);
    }

    /**
     * Advance roaming + animation and place the pets without drawing.
     * `body` = the owner's skeleton for this frame (null = nobody tracked).
     * Pets never pop: hide/show and occlusion are fades; with no body they go to a ledge.
     */
    update(body: BodySnapshot | null, dtSec: number): void {
        const now = performance.now();
        const mouth = this.#mouth(now);
        const pin = this.pinhole;
        const debug: PetDebug[] = [];
        for (const [side, slot] of this.#slots) {
            slot.fade = fadeToward(slot.fade, this.#hidden ? 0 : 1, dtSec * 1000, 300);
            const pose = slot.roamer.update(body, pin, now, dtSec, this.#pointAt);
            slot.pose = pose;
            const visible = slot.fade > 0.001;
            slot.actor.visible = visible;
            slot.shadow.visible = visible && pose.settled && pose.gait !== "fly";
            // LOD: skip the mixer/skinning updates while invisible; tick at half rate when tiny on screen.
            const s = project(pin, pose.p);
            const px = (PETS[slot.actor.pet].heightM * (pin.height / 2 / Math.tan((pin.vfovDeg * Math.PI) / 360))) / Math.max(s.depthM, 0.05);
            const animate = visible && (px > 40 || Math.floor(now / 16) % 2 === 0);
            slot.actor.tick(pose, now, animate ? dtSec * (px > 40 ? 1 : 2) : 0, mouth, animate);
            slot.alpha.value = slot.fade;
            const petM = s.depthM;
            slot.depth.value = petM;
            slot.inFront = personInFront(slot.inFront, body?.present ? body.distanceM : undefined, petM);
            slot.front.value = fadeToward(slot.front.value, slot.inFront ? 1 : 0, dtSec * 1000);
            // Shadow on the perch surface, slightly above to avoid z-fighting with nothing.
            const sw = PETS[slot.actor.pet].heightM * 0.9;
            slot.shadow.position.set(pose.p[0], pose.p[1] + 0.002, pose.p[2]);
            slot.shadow.scale.set(sw, sw * 0.6, 1);
            slot.shadowAlpha.value = slot.fade;
            debug.push({ side, pet: slot.actor.pet, pose, screen: s, personInFront: slot.front.value, animating: animate });
        }
        this.#debug = debug;
        if (this.#pointAt && [...this.#slots.values()].every((s) => s.roamer.anchor !== "point")) this.#pointAt = null;
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
        for (const side of [...this.#slots.keys()]) this.#remove(side);
        this.renderer.dispose();
    }
}
