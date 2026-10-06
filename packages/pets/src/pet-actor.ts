import * as THREE from "three/webgpu";

import type { PetId } from "./catalogue.js";
import { AngularSpring, BLINK_SHIFT, Breath, IdleTwitch, Saccade, Squash, inertialTarget, stretchFactor } from "./procedural.js";
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
/** Head follows the eyes fast, the neck catches up later (time constants, s). */
const HEAD_TAU = 0.05;
const NECK_TAU = 0.3;
/** Spring follow-through gains: rad per m/s² of root acceleration, rad per rad/s of yaw rate. */
const TAIL_GAIN = 0.06;
const TAIL_YAW_GAIN = 0.08;
const EAR_GAIN = 0.035;
const EAR_YAW_GAIN = 0.04;
/** Acceleration clamp (m/s²): teleports and first frames must not whip the tail. */
const MAX_ACC = 25;

type MouthWeights = ReturnType<typeof mouthWeights>;
type Gait = PetPose["gait"];

/** One spring-driven bone: clip pose restored each frame, then a root-frame deflection added. */
interface SpringBone {
    bone: THREE.Bone;
    rest: THREE.Quaternion;
    /** Bone orientation in the pet root frame (bind) and its inverse. */
    q: THREE.Quaternion;
    qInv: THREE.Quaternion;
    /** Bone axis (+Y) in the root frame. */
    dir: [number, number, number];
    spring: AngularSpring;
    gain: number;
    yawGain: number;
}

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
    readonly #chest: THREE.Bone | null;
    readonly #chestRest = new THREE.Quaternion();
    readonly #springs: SpringBone[] = [];
    readonly #earL: SpringBone | null;
    readonly #earR: SpringBone | null;
    readonly #saccade: Saccade;
    readonly #breath: Breath;
    readonly #twitch: IdleTwitch;
    readonly #squash = new Squash();
    /** Root scale set by the stage (scaleM); squash/stretch multiply it. */
    readonly #baseScale = new THREE.Vector3(1, 1, 1);
    #baseScaleCaptured = false;
    #arousal = 0.3;
    #behaviour: THREE.AnimationAction | null = null;
    #gait: THREE.AnimationAction | null = null;
    #gaitWeight = 0;
    #lookYaw = 0;
    #lookPitch = 0;
    #neckYaw = 0;
    #neckPitch = 0;
    #nextBlink: number;
    #blinkT = -1;
    #visible = true;
    // Root kinematics (world metres) for follow-through and squash.
    #hasPrev = false;
    readonly #prevP: [number, number, number] = [0, 0, 0];
    readonly #vel: [number, number, number] = [0, 0, 0];
    #prevYaw = 0;
    #yawRate = 0;
    #prevGait: Gait = null;
    #prevSettled = true;
    #flew = false;
    readonly #acc: [number, number, number] = [0, 0, 0];
    readonly #target: [number, number, number] = [0, 0, 0];

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
        let chest: THREE.Bone | null = null;
        const named = new Map<string, THREE.Bone>();
        gltfScene.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if ((o as THREE.Bone).isBone) {
                if (o.name === "head") head = o as THREE.Bone;
                if (o.name === "neck") neck = o as THREE.Bone;
                if (o.name === "chest") chest = o as THREE.Bone;
                named.set(o.name, o as THREE.Bone);
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
        this.#chest = chest;
        // Bind pose: restored before every mixer update, so the look-at offset is applied
        // to the CLIP pose once per frame. Without this, bones the current clip does not
        // key keep the previous frame's look-at and it accumulates (the head spun forever).
        if (this.#head) this.#headRest.copy((this.#head as THREE.Bone).quaternion);
        if (this.#neck) this.#neckRest.copy((this.#neck as THREE.Bone).quaternion);
        if (this.#chest) this.#chestRest.copy((this.#chest as THREE.Bone).quaternion);
        // Spring bones: tail chain gets looser toward the tip (whip), ears are stiff and bouncy.
        this.root.updateMatrixWorld(true);
        const tails: [string, number, number][] = [
            ["tail1", 14, 0.55],
            ["tail2", 11, 0.45],
            ["tail3", 9, 0.4],
        ];
        for (const [name, omega, zeta] of tails) {
            const b = named.get(name);
            if (b) this.#springs.push(this.#springBone(b, new AngularSpring(omega, zeta), TAIL_GAIN, TAIL_YAW_GAIN));
        }
        const earL = named.get("ear.L");
        const earR = named.get("ear.R");
        this.#earL = earL ? this.#springBone(earL, new AngularSpring(18, 0.3), EAR_GAIN, EAR_YAW_GAIN) : null;
        this.#earR = earR ? this.#springBone(earR, new AngularSpring(18, 0.3), EAR_GAIN, EAR_YAW_GAIN) : null;
        if (this.#earL) this.#springs.push(this.#earL);
        if (this.#earR) this.#springs.push(this.#earR);
        this.#saccade = new Saccade(rand);
        this.#breath = new Breath(rand() * Math.PI * 2);
        this.#twitch = new IdleTwitch(rand, nowMs / 1000);
        this.#nextBlink = nowMs / 1000 + BLINK_EVERY_S * (0.5 + rand());
        this.#play("idle");
    }

    #springBone(bone: THREE.Bone, spring: AngularSpring, gain: number, yawGain: number): SpringBone {
        // Root is still identity here (the stage scales it after construction), so the world
        // quaternion is the bone's orientation in the root frame.
        const q = bone.getWorldQuaternion(new THREE.Quaternion());
        const d = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        return { bone, rest: bone.quaternion.clone(), q, qInv: q.clone().invert(), dir: [d.x, d.y, d.z], spring, gain, yawGain };
    }

    get object(): THREE.Object3D {
        return this.#model;
    }

    /** World metres per model unit (the stage's scaleM x the owner's resize); squash/stretch multiply it. */
    setBaseScale(s: number): void {
        if (!(s > 0) || !Number.isFinite(s)) return;
        this.#baseScale.setScalar(s);
        this.#baseScaleCaptured = true;
        this.root.scale.setScalar(s);
    }

    /** 0..1 excitement: faster, deeper breathing and shorter gaze holds. Default 0.3. */
    setArousal(v: number): void {
        this.#arousal = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.3));
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
        if (!this.#baseScaleCaptured) {
            // First tick: the stage has set scaleM by now; everything after multiplies it.
            this.#baseScale.copy(this.root.scale);
            this.#baseScaleCaptured = true;
        }
        if (!animate) return;
        this.#play(this.brain.tick(nowMs));
        this.#setGait(pose.gait, pose.gaitWeight, dtSec);
        this.#head?.quaternion.copy(this.#headRest);
        this.#neck?.quaternion.copy(this.#neckRest);
        this.#chest?.quaternion.copy(this.#chestRest);
        for (const s of this.#springs) s.bone.quaternion.copy(s.rest);
        this.#mixer.update(dtSec);
        const tSec = nowMs / 1000;
        this.#kinematics(pose, dtSec);
        const ev = this.#twitch.step(tSec);
        if (ev === "earL" || ev === "earR") {
            const ear = ev === "earL" ? this.#earL : this.#earR;
            ear?.spring.impulse(0, 0, (ev === "earL" ? 1 : -1) * (3 + 3 * this.#rand()));
        }
        this.#lookAt(pose.lookAt, dtSec);
        this.#breathe(dtSec);
        this.#springStep(dtSec);
        this.#squashStretch(pose, dtSec);
        this.#blinkStep(tSec, dtSec);
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
    readonly #tmpAxis = new THREE.Vector3();

    /** Root velocity/acceleration (root frame, m/s²) and yaw rate from successive poses. */
    #kinematics(pose: PetPose, dt: number): void {
        const [px, py, pz] = pose.p;
        const prev = this.#prevP;
        const vel = this.#vel;
        const acc = this.#acc;
        if (!this.#hasPrev || !(dt > 1e-4)) {
            if (!this.#hasPrev) {
                prev[0] = px;
                prev[1] = py;
                prev[2] = pz;
                this.#prevYaw = pose.yaw;
                this.#hasPrev = true;
            }
            acc[0] = 0;
            acc[1] = 0;
            acc[2] = 0;
            return;
        }
        // Light smoothing on velocity (the roamer is already smooth; this kills dt jitter).
        const k = Math.min(dt / 0.04, 1);
        const vx = vel[0] + ((px - prev[0]) / dt - vel[0]) * k;
        const vy = vel[1] + ((py - prev[1]) / dt - vel[1]) * k;
        const vz = vel[2] + ((pz - prev[2]) / dt - vel[2]) * k;
        const ax = (vx - vel[0]) / dt;
        const ay = (vy - vel[1]) / dt;
        const az = (vz - vel[2]) / dt;
        vel[0] = vx;
        vel[1] = vy;
        vel[2] = vz;
        prev[0] = px;
        prev[1] = py;
        prev[2] = pz;
        // World -> root frame (yaw only; lean is small).
        const c = Math.cos(pose.yaw);
        const s = Math.sin(pose.yaw);
        let lx = c * ax - s * az;
        let lz = s * ax + c * az;
        let ly = ay;
        const m = Math.hypot(lx, ly, lz);
        if (m > MAX_ACC) {
            const f = MAX_ACC / m;
            lx *= f;
            ly *= f;
            lz *= f;
        }
        acc[0] = lx;
        acc[1] = ly;
        acc[2] = lz;
        let dy = pose.yaw - this.#prevYaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        this.#yawRate += (dy / dt - this.#yawRate) * k;
        this.#prevYaw = pose.yaw;
    }

    /**
     * Saccadic gaze toward a world point: the eyes (head) jump and hold, the neck
     * catches up slowly. Plus the idle head tilt. Big shifts blink.
     */
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
        const shift = this.#saccade.step(dt, yaw, pitch, this.#arousal);
        if (shift > BLINK_SHIFT && this.#blinkT < 0) this.#blinkT = 0;
        // Head rides the saccade almost rigidly; the neck follows later.
        const kh = 1 - Math.exp(-dt / HEAD_TAU);
        const kn = 1 - Math.exp(-dt / NECK_TAU);
        this.#lookYaw += (this.#saccade.yaw - this.#lookYaw) * kh;
        this.#lookPitch += (this.#saccade.pitch - this.#lookPitch) * kh;
        this.#neckYaw += (this.#saccade.yaw - this.#neckYaw) * kn;
        this.#neckPitch += (this.#saccade.pitch - this.#neckPitch) * kn;
        // Bones point up (+Y local in glTF): yaw = rotation about local Y, pitch about local X.
        // Head takes whatever the neck has not reached yet, so the total gaze is exact.
        const ny = this.#neck ? this.#neckYaw * 0.3 : 0;
        const np = this.#neck ? this.#neckPitch * 0.3 : 0;
        this.#tmpE.set(-(this.#lookPitch - np), this.#lookYaw - ny, this.#twitch.tilt, "YXZ");
        this.#tmpQ.setFromEuler(this.#tmpE);
        head.quaternion.multiply(this.#tmpQ);
        if (this.#neck) {
            this.#tmpE.set(-np, ny, 0, "YXZ");
            this.#tmpQ.setFromEuler(this.#tmpE);
            this.#neck.quaternion.multiply(this.#tmpQ);
        }
    }

    /** Chest pitch breathing; the neck counter-rotates so the gaze stays put. */
    #breathe(dt: number): void {
        const v = this.#breath.step(dt, this.#arousal);
        if (!this.#chest) return;
        this.#tmpQ.setFromAxisAngle(this.#tmpAxis.set(1, 0, 0), v);
        this.#chest.quaternion.multiply(this.#tmpQ);
        if (this.#neck) {
            this.#tmpQ.setFromAxisAngle(this.#tmpAxis.set(1, 0, 0), -v * 0.8);
            this.#neck.quaternion.multiply(this.#tmpQ);
        }
    }

    /** Follow-through: each spring lags the root's acceleration/turn, clamped, added to the clip pose. */
    #springStep(dt: number): void {
        const a = this.#acc;
        for (const s of this.#springs) {
            inertialTarget(s.dir, a[0], a[1], a[2], this.#yawRate, s.gain, s.yawGain, this.#target);
            s.spring.step(dt, this.#target[0], this.#target[1], this.#target[2]);
            const m = s.spring.magnitude;
            if (m < 1e-5) continue;
            // Root-frame rotation -> bone-local: q⁻¹ · R · q.
            this.#tmpQ.setFromAxisAngle(this.#tmpAxis.set(s.spring.x / m, s.spring.y / m, s.spring.z / m), m);
            this.#tmpQ.premultiply(s.qInv).multiply(s.q);
            s.bone.quaternion.multiply(this.#tmpQ);
        }
    }

    /** Landing squash, hop anticipation, flight stretch; multiplies the stage's base scale. */
    #squashStretch(pose: PetPose, dt: number): void {
        const g = pose.gait;
        if (g === "fly") this.#flew = true;
        if (g === "hop" && this.#prevGait !== "hop") this.#squash.start(0.1, 0.1);
        else if (this.#prevGait === "hop" && g !== "hop") this.#squash.start(0.15, 0.12);
        else if (pose.settled && !this.#prevSettled && this.#flew) this.#squash.start(0.15, 0.12);
        if (pose.settled) this.#flew = false;
        this.#prevGait = g;
        this.#prevSettled = pose.settled;
        this.#squash.step(dt);
        let sx = this.#squash.xz;
        let sy = this.#squash.y;
        let sz = this.#squash.xz;
        if (g === "fly") {
            const v = this.#vel;
            const speed = Math.hypot(v[0], v[1], v[2]);
            const st = stretchFactor(speed);
            if (st > 1.0005) {
                // Volume-preserving stretch split between the vertical and the forward axis.
                const f = Math.abs(v[1]) / speed;
                const ls = Math.log(st);
                sy *= Math.exp(ls * (f - (1 - f) / 2));
                sz *= Math.exp(ls * (1 - f - f / 2));
                sx *= Math.exp(-ls / 2);
            }
        }
        const b = this.#baseScale;
        this.root.scale.set(b.x * sx, b.y * sy, b.z * sz);
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
