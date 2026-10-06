import * as THREE from "three/webgpu";

import type { PetId } from "./catalogue.js";
import type { PetPose } from "./roam.js";
import { PetStateMachine, type PetClip, type PetEvent } from "./state-machine.js";
import { MOUTH_SHAPES, type mouthWeights } from "./visemes.js";
import type { Vec3 } from "./space.js";

/** Head look-at limits (radians). */
const LOOK_YAW = 1.0;
const LOOK_PITCH = 0.5;
/** Seconds between blinks (mean) and blink length. */
const BLINK_EVERY_S = 3.6;
const BLINK_S = 0.14;
/** Behaviour crossfade (s). */
const FADE_S = 0.25;

type MouthWeights = ReturnType<typeof mouthWeights>;

/**
 * One pet in the scene: skinned glTF, its behaviour brain, a locomotion layer
 * blended over the behaviour clip, procedural head look-at and blink on top.
 * Pose (position/yaw) comes from PetRoamer; this class only animates.
 */
export class PetActor {
    readonly pet: PetId;
    /** World-space holder (metres); the glTF scene is its child. */
    readonly root = new THREE.Group();
    readonly brain: PetStateMachine;
    readonly #model: THREE.Object3D;
    readonly #mixer: THREE.AnimationMixer;
    readonly #actions = new Map<string, THREE.AnimationAction>();
    readonly #mouth: { mesh: THREE.Mesh; index: number[] }[] = [];
    readonly #blink: { mesh: THREE.Mesh; index: number }[] = [];
    readonly #head: THREE.Bone | null;
    readonly #neck: THREE.Bone | null;
    readonly #headRest = new THREE.Quaternion();
    readonly #neckRest = new THREE.Quaternion();
    /** Model-space height of the head (look-at origin). */
    readonly #headY: number;
    readonly #rand: () => number;
    #behaviour: THREE.AnimationAction | null = null;
    #gait: THREE.AnimationAction | null = null;
    #gaitWeight = 0;
    #lookYaw = 0;
    #lookPitch = 0;
    #nextBlink: number;
    #blinkT = -1;
    #visible = true;

    constructor(
        pet: PetId,
        gltfScene: THREE.Object3D,
        clips: readonly THREE.AnimationClip[],
        nowMs: number,
        modelHeight = 1,
        rand: () => number = Math.random,
    ) {
        this.pet = pet;
        this.#rand = rand;
        this.#headY = modelHeight * 0.75;
        this.#model = gltfScene;
        this.root.add(gltfScene);
        this.root.name = `pet:${pet}`;
        this.brain = new PetStateMachine(nowMs);
        this.#mixer = new THREE.AnimationMixer(gltfScene);
        for (const c of clips) this.#actions.set(c.name, this.#mixer.clipAction(c));
        let head: THREE.Bone | null = null;
        let neck: THREE.Bone | null = null;
        gltfScene.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if ((o as THREE.Bone).isBone) {
                if (o.name === "head") head = o as THREE.Bone;
                if (o.name === "neck") neck = o as THREE.Bone;
            }
            if (!mesh.isMesh) return;
            // Bounds are computed from the bind pose; skinned pets move inside a small box.
            mesh.frustumCulled = false;
            const dict = mesh.morphTargetDictionary;
            if (dict && mesh.morphTargetInfluences) {
                const mouthIdx = MOUTH_SHAPES.map((s) => dict[`mouth_${s}`] ?? -1);
                if (mouthIdx.some((i) => i >= 0)) this.#mouth.push({ mesh, index: mouthIdx });
                const b = dict["blink"];
                if (b !== undefined) this.#blink.push({ mesh, index: b });
            }
        });
        this.#head = head;
        this.#neck = neck;
        // Bind pose: restored before every mixer update, so the look-at offset is applied
        // to the CLIP pose once per frame. Without this, bones the current clip does not
        // key keep the previous frame's look-at and it accumulates (the head spun forever).
        if (this.#head) this.#headRest.copy((this.#head as THREE.Bone).quaternion);
        if (this.#neck) this.#neckRest.copy((this.#neck as THREE.Bone).quaternion);
        this.#nextBlink = nowMs / 1000 + BLINK_EVERY_S * (0.5 + rand());
        this.#play("idle");
    }

    get object(): THREE.Object3D {
        return this.#model;
    }

    send(event: PetEvent, nowMs: number): void {
        this.brain.send(event, nowMs);
    }

    #play(clip: PetClip): void {
        const next = this.#actions.get(clip) ?? this.#actions.get("idle");
        if (!next || next === this.#behaviour) return;
        const once = clip === "react" || clip === "hop" || clip === "wave" || clip === "look";
        next.reset();
        next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
        next.clampWhenFinished = once;
        next.enabled = true;
        next.setEffectiveTimeScale(1);
        next.setEffectiveWeight(1);
        next.play();
        if (this.#behaviour) this.#behaviour.crossFadeTo(next, FADE_S, false);
        this.#behaviour = next;
    }

    #setGait(name: "fly" | "walk" | "hop" | null, weight: number, dt: number): void {
        const want = name ? (this.#actions.get(name) ?? null) : null;
        if (want !== this.#gait) {
            if (this.#gait) this.#gait.fadeOut(0.2);
            if (want) {
                want.reset();
                want.setLoop(name === "hop" ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
                want.clampWhenFinished = name === "hop";
                want.setEffectiveWeight(0);
                want.play();
            }
            this.#gait = want;
            this.#gaitWeight = 0;
        }
        if (!this.#gait) return;
        // Smooth weight; the behaviour clip keeps (1 - w) so idle/talk still shows through.
        this.#gaitWeight += (weight - this.#gaitWeight) * Math.min(dt / 0.15, 1);
        this.#gait.setEffectiveWeight(this.#gaitWeight);
        this.#behaviour?.setEffectiveWeight(Math.max(1 - this.#gaitWeight, 0.15));
    }

    set visible(v: boolean) {
        this.#visible = v;
        this.root.visible = v;
    }

    get visible(): boolean {
        return this.#visible;
    }

    /**
     * Advance one frame: behaviour clip, locomotion blend, mixer, then
     * procedural look-at, blink and lip-sync on top. `scaleM` = world height of
     * the model (metres per model unit is applied by the caller via root.scale).
     */
    tick(pose: PetPose, nowMs: number, dtSec: number, mouth: MouthWeights | null, animate: boolean): void {
        this.root.position.set(pose.p[0], pose.p[1], pose.p[2]);
        this.root.rotation.set(pose.pitch, pose.yaw, pose.roll, "YXZ");
        if (!animate) return;
        this.#play(this.brain.tick(nowMs));
        this.#setGait(pose.gait, pose.gaitWeight, dtSec);
        this.#head?.quaternion.copy(this.#headRest);
        this.#neck?.quaternion.copy(this.#neckRest);
        this.#mixer.update(dtSec);
        this.#lookAt(pose.lookAt, dtSec);
        this.#blinkStep(nowMs / 1000, dtSec);
        for (const m of this.#mouth) {
            const inf = m.mesh.morphTargetInfluences;
            if (!inf) continue;
            for (let k = 0; k < m.index.length; k++) {
                const i = m.index[k] ?? -1;
                const shape = MOUTH_SHAPES[k];
                if (i >= 0 && shape) inf[i] = mouth ? mouth[shape] : k === 0 ? 1 : 0;
            }
        }
    }

    readonly #tmpV = new THREE.Vector3();
    readonly #tmpQ = new THREE.Quaternion();
    readonly #tmpE = new THREE.Euler();

    /** Add a clamped yaw/pitch on the head (and a little on the neck) toward a world point. */
    #lookAt(target: Vec3, dt: number): void {
        const head = this.#head;
        if (!head) return;
        // Target in the pet root's local frame (the model faces +Z).
        this.root.updateMatrixWorld();
        const local = this.#tmpV.set(target[0], target[1], target[2]);
        this.root.worldToLocal(local);
        // Aim from the head (model units, same space as `local`). Targets behind the pet
        // clamp at the yaw limit instead of flipping through ±180°.
        const yaw = Math.max(-LOOK_YAW, Math.min(LOOK_YAW, Math.atan2(local.x, Math.max(local.z, 0.05))));
        const pitch = Math.max(-LOOK_PITCH, Math.min(LOOK_PITCH, Math.atan2(local.y - this.#headY, Math.hypot(local.x, local.z))));
        // Slow, calm head turns (~0.35 s).
        const k = 1 - Math.exp(-dt / 0.35);
        this.#lookYaw += (yaw - this.#lookYaw) * k;
        this.#lookPitch += (pitch - this.#lookPitch) * k;
        // Bones point up (+Y local in glTF): yaw = rotation about local Y, pitch about local X.
        this.#tmpE.set(-this.#lookPitch * 0.7, this.#lookYaw * 0.7, 0, "YXZ");
        this.#tmpQ.setFromEuler(this.#tmpE);
        head.quaternion.multiply(this.#tmpQ);
        if (this.#neck) {
            this.#tmpE.set(-this.#lookPitch * 0.3, this.#lookYaw * 0.3, 0, "YXZ");
            this.#tmpQ.setFromEuler(this.#tmpE);
            this.#neck.quaternion.multiply(this.#tmpQ);
        }
    }

    #blinkStep(tSec: number, dt: number): void {
        if (this.#blink.length === 0) return;
        let v = 0;
        if (this.#blinkT >= 0) {
            this.#blinkT += dt;
            const t = this.#blinkT / BLINK_S;
            v = t < 0.5 ? t * 2 : Math.max(0, 2 - t * 2);
            if (t >= 1) {
                this.#blinkT = -1;
                v = 0;
                // Occasional double blink.
                this.#nextBlink = tSec + (this.#rand() < 0.15 ? 0.18 : BLINK_EVERY_S * (0.4 + this.#rand() * 1.2));
            }
        } else if (tSec >= this.#nextBlink) this.#blinkT = 0;
        // Asleep: eyes closed.
        if (this.brain.clip === "sleep") v = 1;
        for (const b of this.#blink) {
            const inf = b.mesh.morphTargetInfluences;
            if (inf) inf[b.index] = v;
        }
    }

    dispose(): void {
        this.#mixer.stopAllAction();
        this.#mixer.uncacheRoot(this.#model);
        this.root.removeFromParent();
    }
}
