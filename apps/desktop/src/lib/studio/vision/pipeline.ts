import { FaceLandmarker, FilesetResolver, GestureRecognizer, ObjectDetector, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { signalFamily, type IdentityProfile, type SignalEvent, type SignalFamily, type SignalId, type Subject, type VisionSnapshot } from "@tiksee/core";
import {
    boxOfPoints,
    classifyHand,
    DistanceEstimator,
    FaceAnalyzer,
    handObservations,
    headPose,
    IdentityVoter,
    matchProfile,
    MotionAnalyzer,
    neckRatio,
    pickOwner,
    PostureAnalyzer,
    shoulderWidth,
    SignalTracker,
    StateAnalyzer,
    SubjectTracker,
    toDisplay,
    toUpright,
    TwoHandAnalyzer,
    uprightSize,
    type Blendshapes,
    type Box,
    type HandShape,
    type Match,
    type Obs,
    type Pt,
    type Pulse,
    type Side,
    type StateObject,
} from "@tiksee/vision";

import type { CalibrationSample, DogBox, EnrolSample, FaceBox, GestureHint, RawLandmark, VisionFrame } from "../controller.js";
import { DepthModel } from "./depth.js";
import { alignFace, cropBox, Embedder, orderFacePoints, thumbnail, type Crop } from "./identity.js";
import { ensureModels } from "./models.js";
import type { OptionalModel, PipelineConfig, Rotation } from "./protocol.js";

/**
 * The vision pipeline: MediaPipe tasks + ONNX models -> per-frame VisionFrame.
 * Runs inside the vision worker (default) or on the main thread (fallback,
 * staggered schedule). Pure classification lives in @tiksee/vision.
 *
 * Spaces: MediaPipe results are normalised RAW camera coords and VisionFrame
 * keeps them raw. Classifiers get DISPLAY space: upright (camera `rotation`
 * applied) and mirrored like the preview, in upright camera pixels at full
 * camera resolution (calibration shoulderPx / ipdPx use the same unit).
 */

const WASM = "/mediapipe/wasm";

type FactoryScope = { ModuleFactory?: unknown };
let moduleFactory: unknown;

/**
 * tasks-vision imports the wasm loader for every task and then clears
 * `self.ModuleFactory`. In a module worker that loader is an ES module, which
 * the realm evaluates only once, so the second task finds no factory
 * ("ModuleFactory not set.", measured 2026-10-06). Keep the first factory and
 * put it back before each create; the loader re-import is then a no-op.
 */
async function withModuleFactory<T>(make: () => Promise<T>): Promise<T> {
    const g = globalThis as FactoryScope;
    if (moduleFactory === undefined && typeof document === "undefined") {
        const mod = (await import(/* @vite-ignore */ `${WASM}/vision_wasm_module_internal.js`)) as { default?: unknown };
        moduleFactory = mod.default ?? g.ModuleFactory;
    }
    if (moduleFactory !== undefined) g.ModuleFactory = moduleFactory;
    return make();
}
const ASSETS = {
    pose: "/mediapipe/pose_landmarker_lite.task",
    gesture: "/mediapipe/gesture_recognizer.task",
    face: "/mediapipe/face_landmarker.task",
    objects: "/mediapipe/efficientdet_lite0.tflite",
};
const OBJECT_LABELS = ["person", "dog", "cup", "bottle", "cell phone", "wine glass"];
const OBJECT_INTERVAL_MS = 200;
const OBJECT_TTL_MS = 1000;
const DEPTH_INTERVAL_MS = 100;
const IDENTITY_INTERVAL_MS = 2000;
const SNAPSHOT_MS = 500;
/** Synthetic subject for scene-level signals (away, owner_present); never listed in the snapshot. */
const SCENE_TRACK = 2_000_000_000;
const DOG_TRACK_BASE = 1_000_000;
const ALL_FAMILIES: SignalFamily[] = ["hand", "twoHands", "motion", "face", "posture", "state", "presence"];
const HINT_FAMILIES = new Set<SignalFamily>(["hand", "twoHands", "face"]);

/** Face mesh indices (478-point model with irises). */
const FM = { RIGHT_IRIS: 468, LEFT_IRIS: 473, NOSE_TIP: 1, MOUTH_LEFT: 291, MOUTH_RIGHT: 61, LIP_TOP: 13, LIP_BOTTOM: 14 };

interface Tasks {
    pose: PoseLandmarker | null;
    gesture: GestureRecognizer | null;
    face: FaceLandmarker | null;
    objects: ObjectDetector | null;
}

interface HandDet {
    raw: NormalizedLandmark[];
    disp: Pt[];
    side: Side;
    shape: HandShape;
}

interface FaceDet {
    raw: NormalizedLandmark[];
    disp: Pt[];
    bs: Blendshapes;
    matrix: number[] | null;
    /** Display-normalised box. */
    box: Box;
}

interface Person {
    box: Box;
    pose: NormalizedLandmark[] | null;
    poseDisp: Pt[] | null;
    face: FaceDet | null;
    hands: HandDet[];
}

interface PersonState {
    face: FaceAnalyzer;
    posture: PostureAnalyzer;
    states: StateAnalyzer;
    two: TwoHandAnalyzer;
    motion: Record<Side, MotionAnalyzer>;
    distance: DistanceEstimator;
    lastCentre: Pt | null;
    lastHead: { yaw: number; pitch: number; t: number } | null;
    distanceM: number | undefined;
}

interface RawObject {
    label: string;
    score: number;
    /** Raw normalised. */
    box: Box;
}

interface CalibrationJob {
    until: number;
    resolve: (s: CalibrationSample) => void;
    acc: Record<"blinkLeft" | "blinkRight" | "smile" | "mouthOpen" | "browsUp" | "shoulderPx" | "ipdPx" | "neckRatio", number[]>;
    frames: number;
    faceFrames: number;
}

interface EnrolJob {
    kind: "person" | "dog";
    until: number;
    resolve: (s: EnrolSample | null) => void;
    reject: (e: Error) => void;
}

const bs = (b: Blendshapes, k: string) => b[k] ?? 0;
const at = <T>(a: readonly T[], i: number): T | undefined => a[i];

function ema(map: Record<string, number>, key: string, ms: number): void {
    const prev = map[key];
    map[key] = prev === undefined ? ms : prev + 0.1 * (ms - prev);
}

function rawBox(points: readonly NormalizedLandmark[]): Box {
    let x1 = 1;
    let y1 = 1;
    let x2 = 0;
    let y2 = 0;
    for (const p of points) {
        x1 = Math.min(x1, p.x);
        y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x);
        y2 = Math.max(y2, p.y);
    }
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

export class VisionPipeline {
    #cfg: PipelineConfig | null = null;
    #tasks: Tasks = { pose: null, gesture: null, face: null, objects: null };
    #fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
    #delegates: Record<string, string> = {};
    readonly #timings: Record<string, number> = {};
    #frameNo = 0;
    #lastTs = 0;

    readonly #signals = new SignalTracker();
    readonly #people = new SubjectTracker<Person>();
    readonly #dogs = new SubjectTracker<RawObject>({ enterMs: 1000, leaveMs: 3000 }, DOG_TRACK_BASE);
    readonly #state = new Map<number, PersonState>();
    readonly #scenePosture = new PostureAnalyzer({ shoulderPx: 0, neckRatio: 0 });
    #ownerTrack: number | null = null;

    #poses: RawLandmark[][] = [];
    #objects: RawObject[] = [];
    #objectsAt = -Infinity;
    #lastObjectRun = -Infinity;

    readonly #embedder = new Embedder();
    readonly #depth = new DepthModel();
    #depthBusy = false;
    #lastDepth = -Infinity;
    #freshDepth: VisionFrame["depth"] = null;
    #profiles: IdentityProfile[] = [];
    readonly #personVoter = new IdentityVoter(5);
    readonly #dogVoter = new IdentityVoter(5);
    readonly #lastIdentity = new Map<number, number>();
    #idBusy = false;

    #snapshot: VisionSnapshot = { at: 0, subjects: [], perf: { renderFps: 0, cameraFps: 0, visionMs: {}, vcamFps: 0 } };
    #lastSnapshot = -Infinity;
    #calibration: CalibrationJob | null = null;
    #enrol: EnrolJob | null = null;

    get timings(): Record<string, number> {
        return { ...this.#timings };
    }

    get delegates(): Record<string, string> {
        return { ...this.#delegates };
    }

    async init(cfg: PipelineConfig): Promise<void> {
        this.#fileset = await FilesetResolver.forVisionTasks(WASM, needsModuleLoader());
        await this.apply(cfg);
    }

    async apply(cfg: PipelineConfig): Promise<void> {
        const prev = this.#cfg;
        this.#cfg = cfg;
        const s = cfg.settings;
        const fam = s.families;
        const on = (f: SignalFamily) => s.enabled && fam[f] !== false;
        const needHands = on("hand") || on("twoHands") || on("motion");
        const needFace = on("face") || on("state") || (s.enabled && s.identity);
        const needObjects = on("presence") || on("state");

        this.#signals.setArm(s.armHoldMs, s.armWindowMs);
        const holds: Partial<Record<SignalId, number>> = {};
        for (const r of s.rules) {
            if (!r.enabled) continue;
            for (const t of r.triggers) if (t.type === "signal" && t.on === "hold") holds[t.signal] = Math.max(holds[t.signal] ?? 0, t.holdMs);
        }
        this.#signals.setHoldTargets(holds);
        for (const st of this.#state.values()) {
            st.face.setCalibration(s.calibration);
            st.posture.setCalibration(s.calibration);
            st.distance.setCalibration(s.calibration);
        }
        this.#scenePosture.setCalibration(s.calibration);

        const fileset = this.#fileset;
        if (!fileset) return;
        const n = s.maxPeople;
        const changedN = prev?.settings.maxPeople !== n;
        await this.#ensure("pose", s.enabled, changedN, () =>
            PoseLandmarker.createFromOptions(fileset, {
                ...this.#base(ASSETS.pose, "pose"),
                runningMode: "VIDEO",
                numPoses: n,
                minPoseDetectionConfidence: 0.5,
                minPosePresenceConfidence: 0.5,
                minTrackingConfidence: 0.5,
                outputSegmentationMasks: true,
            }),
        );
        await this.#ensure("gesture", needHands, changedN, () =>
            GestureRecognizer.createFromOptions(fileset, {
                ...this.#base(ASSETS.gesture, "gesture"),
                runningMode: "VIDEO",
                numHands: 2 * n,
                minHandDetectionConfidence: 0.5,
                minHandPresenceConfidence: 0.5,
                minTrackingConfidence: 0.5,
            }),
        );
        await this.#ensure("face", needFace, changedN, () =>
            FaceLandmarker.createFromOptions(fileset, {
                ...this.#base(ASSETS.face, "face"),
                runningMode: "VIDEO",
                numFaces: n,
                outputFaceBlendshapes: true,
                outputFacialTransformationMatrixes: true,
            }),
        );
        await this.#ensure("objects", needObjects, false, () =>
            ObjectDetector.createFromOptions(fileset, {
                ...this.#base(ASSETS.objects, "objects"),
                runningMode: "VIDEO",
                scoreThreshold: 0.4,
                maxResults: 10,
                categoryAllowlist: OBJECT_LABELS,
            }),
        );
    }

    /** GPU delegate on its own OffscreenCanvas; the CPU delegate is used if WebGL fails. */
    #base(path: string, key: string): { baseOptions: { modelAssetPath: string; delegate: "GPU" | "CPU" }; canvas?: OffscreenCanvas } {
        const gpu = this.#delegates[key] !== "CPU";
        return gpu
            ? { baseOptions: { modelAssetPath: path, delegate: "GPU" }, canvas: new OffscreenCanvas(1, 1) }
            : { baseOptions: { modelAssetPath: path, delegate: "CPU" } };
    }

    async #ensure<K extends keyof Tasks>(key: K, wanted: boolean, recreate: boolean, make: () => Promise<NonNullable<Tasks[K]>>): Promise<void> {
        const cur = this.#tasks[key];
        if (cur && (!wanted || recreate)) {
            cur.close();
            this.#tasks[key] = null;
        }
        if (!wanted || this.#tasks[key]) return;
        const t0 = performance.now();
        try {
            this.#delegates[key] = "GPU";
            this.#tasks[key] = await withModuleFactory(make);
        } catch (e) {
            console.warn(`[vision] ${key}: GPU delegate failed, using CPU`, e);
            this.#delegates[key] = "CPU";
            this.#tasks[key] = await withModuleFactory(make);
        }
        ema(this.#timings, `load.${key}`, performance.now() - t0);
    }

    setProfiles(profiles: IdentityProfile[]): void {
        this.#profiles = profiles;
    }

    async ensureModels(which: OptionalModel[], onProgress?: (p: number) => void): Promise<void> {
        const bytes = await ensureModels(which, onProgress);
        const face = bytes.get("identity");
        const dog = bytes.get("dogIdentity");
        const depth = bytes.get("depth");
        if (face) await this.#embedder.loadFace(face);
        if (dog) await this.#embedder.loadDog(dog);
        if (depth) await this.#depth.load(depth);
    }

    calibrate(ms: number): Promise<CalibrationSample> {
        return new Promise((resolve) => {
            this.#calibration = {
                until: performance.now() + ms,
                resolve,
                acc: { blinkLeft: [], blinkRight: [], smile: [], mouthOpen: [], browsUp: [], shoulderPx: [], ipdPx: [], neckRatio: [] },
                frames: 0,
                faceFrames: 0,
            };
            // Resolve even when no frame arrives (camera stopped).
            setTimeout(() => this.#finishCalibration(true), ms + 1500);
        });
    }

    enrol(kind: "person" | "dog"): Promise<EnrolSample | null> {
        if (kind === "person" && !this.#embedder.hasFace) return Promise.reject(new Error("identity model not loaded: call ensureModels(['identity']) first"));
        if (kind === "dog" && !this.#embedder.hasDog) return Promise.reject(new Error("dog identity model not loaded: call ensureModels(['dogIdentity']) first"));
        return new Promise((resolve, reject) => {
            this.#enrol?.resolve(null);
            this.#enrol = { kind, until: performance.now() + 2000, resolve, reject };
            setTimeout(() => {
                if (this.#enrol?.resolve === resolve) {
                    this.#enrol = null;
                    resolve(null);
                }
            }, 3000);
        });
    }

    close(): void {
        for (const k of Object.keys(this.#tasks) as (keyof Tasks)[]) {
            this.#tasks[k]?.close();
            this.#tasks[k] = null;
        }
        this.#embedder.close();
        this.#depth.close();
    }

    /** Process one frame. Closes `bitmap`. */
    async process(bitmap: ImageBitmap, tMs: number, rawW: number, rawH: number): Promise<VisionFrame> {
        const cfg = this.#cfg;
        if (!cfg || !cfg.settings.enabled) {
            bitmap.close();
            return this.#frame(tMs, [], [], [], null, [], undefined);
        }
        const tStart = performance.now();
        const ts = Math.max(Math.round(tMs), this.#lastTs + 1);
        this.#lastTs = ts;
        const frameNo = this.#frameNo++;
        const { settings: s, rotation, mirror, stagger } = cfg;
        const [uw, uh] = uprightSize(rotation, rawW, rawH);
        const disp = (p: { x: number; y: number }, w = uw, h = uh): Pt => {
            const [x, y] = toDisplay(rotation, mirror, p.x, p.y, w, h);
            return { x, y };
        };
        const families = new Set(ALL_FAMILIES.filter((f) => s.families[f] !== false));

        // --- MediaPipe tasks (staggered on the main thread).
        const runPose = !stagger || frameNo % 2 === 0;
        const runGesture = !stagger || frameNo % 2 === 1;
        const runFace = !stagger || frameNo % 2 === 0;
        const runObjects = stagger ? frameNo % 12 === 0 : tMs - this.#lastObjectRun >= OBJECT_INTERVAL_MS;

        let mask: VisionFrame["mask"] = null;
        const t = this.#tasks;
        if (t.pose && runPose) {
            const t0 = performance.now();
            try {
                const r = t.pose.detectForVideo(bitmap, ts);
                this.#poses = r.landmarks.map((lm) => lm.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })));
                const masks = r.segmentationMasks ?? [];
                const first = masks[0];
                if (first) {
                    const data = first.getAsFloat32Array().slice();
                    for (const m of masks.slice(1)) {
                        const d = m.getAsFloat32Array();
                        for (let i = 0; i < data.length; i++) data[i] = Math.max(data[i] ?? 0, d[i] ?? 0);
                    }
                    mask = { data, width: first.width, height: first.height };
                }
                for (const m of masks) m.close();
            } catch (e) {
                console.warn("[vision] pose failed", e);
            }
            ema(this.#timings, "pose", performance.now() - t0);
        }

        let hands: HandDet[] | null = null;
        if (t.gesture && runGesture) {
            const t0 = performance.now();
            try {
                const r = t.gesture.recognizeForVideo(bitmap, ts);
                hands = r.landmarks.map((lm, i) => {
                    // MediaPipe labels handedness as if the image were mirrored; raw camera frames are not.
                    const label = at(r.handedness, i)?.[0]?.categoryName ?? "Right";
                    const side: Side = label === "Left" ? "right" : "left";
                    const g = at(r.gestures, i)?.[0];
                    const d = lm.map((p) => disp(p));
                    return { raw: lm, disp: d, side, shape: classifyHand(d, side, g ? { category: g.categoryName, score: g.score } : undefined) };
                });
            } catch (e) {
                console.warn("[vision] gestures failed", e);
            }
            ema(this.#timings, "hands", performance.now() - t0);
        }
        hands ??= this.#lastHands;
        this.#lastHands = hands;

        let faces: FaceDet[] | null = null;
        if (t.face && runFace) {
            const t0 = performance.now();
            try {
                const r = t.face.detectForVideo(bitmap, ts);
                faces = r.faceLandmarks.map((lm, i) => {
                    const d = lm.map((p) => disp(p, 1, 1));
                    const box = boxOfPoints(d, 0) ?? { x: 0, y: 0, w: 0, h: 0 };
                    const cats = at(r.faceBlendshapes, i)?.categories ?? [];
                    return {
                        raw: lm,
                        disp: lm.map((p) => disp(p)),
                        bs: Object.fromEntries(cats.map((c) => [c.categoryName, c.score])),
                        matrix: at(r.facialTransformationMatrixes, i)?.data ?? null,
                        box,
                    };
                });
            } catch (e) {
                console.warn("[vision] face failed", e);
            }
            ema(this.#timings, "face", performance.now() - t0);
        }
        faces ??= this.#lastFaces;
        this.#lastFaces = faces;

        let objectsFresh = false;
        if (t.objects && runObjects) {
            this.#lastObjectRun = tMs;
            const t0 = performance.now();
            try {
                const r = t.objects.detectForVideo(bitmap, ts);
                this.#objects = r.detections.flatMap((d) => {
                    const c = d.categories[0];
                    const b = d.boundingBox;
                    if (!c || !b) return [];
                    return [{ label: c.categoryName, score: c.score, box: { x: b.originX / bitmap.width, y: b.originY / bitmap.height, w: b.width / bitmap.width, h: b.height / bitmap.height } }];
                });
                this.#objectsAt = tMs;
                objectsFresh = true;
            } catch (e) {
                console.warn("[vision] objects failed", e);
            }
            ema(this.#timings, "objects", performance.now() - t0);
        }
        if (tMs - this.#objectsAt > OBJECT_TTL_MS) this.#objects = [];

        // --- People: poses + faces + hands grouped per person, then tracked.
        const people = this.#group(this.#poses, faces, hands, disp);
        const tracked = this.#people.update(people.map((p) => ({ box: p.box, data: p })), tMs);
        const events: SignalEvent[] = [];

        const identityOwner = [...this.#people.tracks].find((tr) => this.#personVoter.current(tr.id)?.owner)?.id ?? null;
        this.#ownerTrack = pickOwner(this.#people.tracks, tMs, identityOwner ?? this.#ownerTrack);

        const subjectOf = (track: number, kind: "person" | "dog"): Subject => {
            const m = (kind === "dog" ? this.#dogVoter : this.#personVoter).current(track);
            return {
                kind,
                track,
                owner: kind === "person" && track === this.#ownerTrack,
                ...(m ? { profileId: m.profileId, name: m.name } : {}),
            };
        };

        for (const tr of tracked.left) {
            events.push(...this.#signals.leave(tr.id, tMs));
            if (families.has("presence")) events.push(pulse("person_leave", tMs, subjectOf(tr.id, "person")));
            this.#state.delete(tr.id);
            this.#personVoter.forget(tr.id);
            this.#lastIdentity.delete(tr.id);
        }
        if (families.has("presence")) for (const tr of tracked.entered) events.push(pulse("person_enter", tMs, subjectOf(tr.id, "person")));

        const objectsDisp: StateObject[] = this.#objects.map((o) => {
            const a = disp({ x: o.box.x, y: o.box.y });
            const b = disp({ x: o.box.x + o.box.w, y: o.box.y + o.box.h });
            return { label: o.label, score: o.score, box: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) } };
        });

        let ownerPose: Pt[] | null = null;
        let ownerDistanceM: number | undefined;
        for (const tr of this.#people.tracks) {
            if (!tr.visible) continue;
            const p = tr.data;
            const subject = subjectOf(tr.id, "person");
            const st = this.#personState(tr.id);
            const obs: Obs[] = [];
            const pulses: Pulse[] = [];

            // Hands.
            const bySide: Partial<Record<Side, HandDet>> = {};
            for (const h of p.hands) bySide[h.side] ??= h;
            for (const h of p.hands) if (families.has("hand")) obs.push(...handObservations(h.shape));
            if (families.has("motion")) {
                for (const side of ["left", "right"] as const) {
                    const h = bySide[side];
                    const c = h ? { x: h.shape.centre.x / uw, y: h.shape.centre.y / uh } : null;
                    pulses.push(...st.motion[side].update(c, tMs, (h?.shape.fingers ?? 0) >= 4));
                }
            }
            if (families.has("twoHands")) {
                const l = bySide.left;
                const r = bySide.right;
                const two = st.two.update(l ? { shape: l.shape, lm: l.disp } : null, r ? { shape: r.shape, lm: r.disp } : null, tMs);
                obs.push(...two.obs);
                pulses.push(...two.pulses);
            }

            // Face.
            let jaw: number | null = null;
            let smile: number | null = null;
            let mouth: Pt | null = null;
            let faceW = 0;
            let headSpeed = 0;
            if (p.face) {
                const f = p.face;
                const pose = f.matrix ? headPose(f.matrix, rotation, mirror) : { yaw: 0, pitch: 0, roll: 0 };
                const fr = st.face.update(f.bs, pose, tMs);
                if (families.has("face")) {
                    obs.push(...fr.obs);
                    pulses.push(...fr.pulses);
                }
                jaw = bs(f.bs, "jawOpen");
                smile = (bs(f.bs, "mouthSmileLeft") + bs(f.bs, "mouthSmileRight")) / 2;
                const top = at(f.disp, FM.LIP_TOP);
                const bottom = at(f.disp, FM.LIP_BOTTOM);
                mouth = top && bottom ? { x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 } : null;
                faceW = f.box.w * uw;
                if (st.lastHead) {
                    const dt = Math.max((tMs - st.lastHead.t) / 1000, 1e-3);
                    headSpeed = (Math.abs(pose.yaw - st.lastHead.yaw) + Math.abs(pose.pitch - st.lastHead.pitch)) / dt;
                }
                st.lastHead = { yaw: pose.yaw, pitch: pose.pitch, t: tMs };
            } else {
                st.face.reset();
                st.lastHead = null;
            }

            // Posture.
            if (p.poseDisp && families.has("posture")) obs.push(...st.posture.update({ lm: p.poseDisp, frameH: uh }, tMs));

            // States.
            const centre = { x: tr.box.x + tr.box.w / 2, y: tr.box.y + tr.box.h / 2 };
            const motion = st.lastCentre ? Math.hypot(centre.x - st.lastCentre.x, centre.y - st.lastCentre.y) : 0;
            st.lastCentre = centre;
            if (families.has("state")) {
                const handPts = [...p.hands.map((h) => h.shape.centre), ...(p.poseDisp ? [p.poseDisp[15], p.poseDisp[16]].filter((x): x is Pt => !!x && (x.visibility ?? 1) > 0.5) : [])];
                obs.push(...st.states.update({ jawOpen: jaw, smile, mouth, faceW, hands: handPts, objects: objectsDisp, motion, headSpeed }, tMs));
            }

            // Body-scale distance (shoulders + IPD, display px).
            const ipd = p.face ? ipdPx(p.face.disp) : 0;
            const sw = p.poseDisp ? shoulderWidth(p.poseDisp) : 0;
            const swVis = p.poseDisp ? Math.min(p.poseDisp[11]?.visibility ?? 0, p.poseDisp[12]?.visibility ?? 0) : 0;
            st.distanceM = st.distance.update({ px: sw, weight: swVis }, { px: ipd, weight: ipd > 0 ? 1 : 0 }, tMs) ?? undefined;
            if (subject.owner) {
                ownerPose = p.poseDisp;
                ownerDistanceM = st.distanceM;
                this.#calibrationFrame(p, ipd, sw);
            }

            events.push(...this.#signals.update(subject, obs.filter((o) => families.has(signalFamily(o.signal))), pulses, tMs));
        }

        // Scene-level signals on a synthetic owner subject.
        const ownerTr = this.#people.tracks.find((tr) => tr.id === this.#ownerTrack);
        const sceneObs: Obs[] = [];
        if (families.has("posture")) sceneObs.push(...this.#scenePosture.update({ lm: ownerTr?.visible ? ownerPose : null, frameH: uh }, tMs).filter((o) => o.signal === "away"));
        if (families.has("presence") && ownerTr?.present) sceneObs.push({ signal: "owner_present", score: 0.9 });
        const ownerSubject = this.#ownerTrack !== null ? subjectOf(this.#ownerTrack, "person") : null;
        events.push(
            ...this.#signals.update(
                { kind: "person", track: SCENE_TRACK, owner: true, ...(ownerSubject?.profileId ? { profileId: ownerSubject.profileId, name: ownerSubject.name } : {}) },
                sceneObs,
                [],
                tMs,
            ),
        );

        // Dogs (only on fresh detector output so the 1 s / 3 s presence timing holds).
        if (objectsFresh) {
            const dogs = this.#objects.filter((o) => o.label === "dog");
            const ev = this.#dogs.update(dogs.map((d) => ({ box: d.box, data: d })), tMs);
            if (families.has("presence")) {
                for (const tr of ev.entered) events.push(pulse("dog_enter", tMs, subjectOf(tr.id, "dog")));
                for (const tr of ev.left) events.push(pulse("dog_leave", tMs, subjectOf(tr.id, "dog")));
            }
            for (const tr of ev.left) {
                this.#dogVoter.forget(tr.id);
                this.#lastIdentity.delete(tr.id);
            }
        }

        // Identity, enrolment and depth read pixels synchronously, before the bitmap is closed.
        this.#identityTick(bitmap, tMs, rotation);
        this.#enrolTick(bitmap);
        if (s.depth === "model" && this.#depth.loaded && !this.#depthBusy && tMs - this.#lastDepth >= DEPTH_INTERVAL_MS) {
            this.#lastDepth = tMs;
            const t0 = performance.now();
            const job = this.#depth.run(bitmap, rotation);
            if (job) {
                this.#depthBusy = true;
                job.then(
                    (d) => {
                        this.#freshDepth = d;
                        ema(this.#timings, "depth", performance.now() - t0);
                    },
                    (e: unknown) => console.warn("[vision] depth failed", e),
                ).finally(() => (this.#depthBusy = false));
            }
        }
        bitmap.close();
        this.#finishCalibration(false);

        // Output in RAW camera space.
        const faceBoxes = this.#faceBoxes(rotation, mirror, uw, uh, s.calibration.swapEyes);
        const dogBoxes: DogBox[] = this.#dogs.tracks
            .filter((tr) => tr.visible || tMs - tr.lastSeen < OBJECT_TTL_MS)
            .map((tr) => {
                const m = this.#dogVoter.current(tr.id);
                return { ...tr.data.box, track: tr.id, confidence: tr.data.score, ...(m ? { name: m.name } : {}) };
            });
        const hints = s.showGestureHud ? this.#hints(tMs, families) : [];
        ema(this.#timings, "total", performance.now() - tStart);
        return this.#frame(tMs, events, faceBoxes, dogBoxes, mask, hints, ownerDistanceM);
    }

    #lastHands: HandDet[] = [];
    #lastFaces: FaceDet[] = [];

    #personState(track: number): PersonState {
        let st = this.#state.get(track);
        if (!st) {
            const cal = this.#cfg?.settings.calibration ?? { blinkLeft: 0.5, blinkRight: 0.5, smile: 0.6, mouthOpen: 0.45, browsUp: 0.55, swapEyes: false, shoulderPx: 0, ipdPx: 0, referenceM: 1, neckRatio: 0, calibratedAt: 0 };
            st = {
                face: new FaceAnalyzer(cal),
                posture: new PostureAnalyzer(cal),
                states: new StateAnalyzer(),
                two: new TwoHandAnalyzer(),
                motion: { left: new MotionAnalyzer("left"), right: new MotionAnalyzer("right") },
                distance: new DistanceEstimator(cal),
                lastCentre: null,
                lastHead: null,
                distanceM: undefined,
            };
            this.#state.set(track, st);
        }
        return st;
    }

    #group(poses: RawLandmark[][], faces: FaceDet[], hands: HandDet[], disp: (p: { x: number; y: number }, w?: number, h?: number) => Pt): Person[] {
        const people: Person[] = poses.flatMap((lm) => {
            const norm = lm.map((p) => ({ ...disp(p, 1, 1), visibility: p.visibility ?? 1 }));
            const box = boxOfPoints(norm, 0.5);
            if (!box || box.w * box.h <= 0) return [];
            return [{ box, pose: lm as NormalizedLandmark[], poseDisp: lm.map((p) => ({ ...disp(p), visibility: p.visibility ?? 1 })), face: null, hands: [] }];
        });
        // Faces -> the person whose nose is inside (or nearest to) the face box.
        for (const f of faces) {
            const fc = { x: f.box.x + f.box.w / 2, y: f.box.y + f.box.h / 2 };
            let best: Person | null = null;
            let bestD = Infinity;
            for (const p of people) {
                if (p.face || !p.pose) continue;
                const nose = p.pose[0];
                if (!nose) continue;
                const n = disp(nose, 1, 1);
                const d = Math.hypot(n.x - fc.x, n.y - fc.y);
                if (d < Math.max(f.box.w, f.box.h) && d < bestD) {
                    best = p;
                    bestD = d;
                }
            }
            if (best) best.face = f;
            else {
                const w = f.box.w * 3;
                people.push({ box: { x: fc.x - w / 2, y: f.box.y - f.box.h * 0.3, w, h: f.box.h * 4 }, pose: null, poseDisp: null, face: f, hands: [] });
            }
        }
        // Hands -> nearest pose wrist, else nearest person centre.
        for (const h of hands) {
            const w = disp(h.raw[0] ?? { x: 0, y: 0 }, 1, 1);
            let best: Person | null = null;
            let bestD = Infinity;
            for (const p of people) {
                const wrists = p.pose ? [p.pose[15], p.pose[16]].filter((x): x is NormalizedLandmark => !!x).map((x) => disp(x, 1, 1)) : [];
                const c = { x: p.box.x + p.box.w / 2, y: p.box.y + p.box.h / 2 };
                const d = wrists.length > 0 ? Math.min(...wrists.map((x) => Math.hypot(x.x - w.x, x.y - w.y))) : Math.hypot(c.x - w.x, c.y - w.y) + 0.2;
                if (d < bestD) {
                    best = p;
                    bestD = d;
                }
            }
            if (best && best.hands.length < 2) best.hands.push(h);
        }
        return people;
    }

    #calibrationFrame(p: Person, ipd: number, sw: number): void {
        const job = this.#calibration;
        if (!job) return;
        job.frames++;
        if (p.face) {
            job.faceFrames++;
            const b = p.face.bs;
            job.acc.blinkLeft.push(bs(b, "eyeBlinkLeft"));
            job.acc.blinkRight.push(bs(b, "eyeBlinkRight"));
            job.acc.smile.push((bs(b, "mouthSmileLeft") + bs(b, "mouthSmileRight")) / 2);
            job.acc.mouthOpen.push(bs(b, "jawOpen"));
            job.acc.browsUp.push(Math.max(bs(b, "browInnerUp"), (bs(b, "browOuterUpLeft") + bs(b, "browOuterUpRight")) / 2));
            if (ipd > 0) job.acc.ipdPx.push(ipd);
        }
        if (p.poseDisp && sw > 0) {
            job.acc.shoulderPx.push(sw);
            job.acc.neckRatio.push(neckRatio(p.poseDisp));
        }
    }

    #finishCalibration(force: boolean): void {
        const job = this.#calibration;
        if (!job || (!force && performance.now() < job.until)) return;
        this.#calibration = null;
        const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
        job.resolve({
            blinkLeft: avg(job.acc.blinkLeft),
            blinkRight: avg(job.acc.blinkRight),
            smile: avg(job.acc.smile),
            mouthOpen: avg(job.acc.mouthOpen),
            browsUp: avg(job.acc.browsUp),
            shoulderPx: avg(job.acc.shoulderPx),
            ipdPx: avg(job.acc.ipdPx),
            neckRatio: avg(job.acc.neckRatio),
            faceVisible: job.frames > 0 && job.faceFrames / job.frames > 0.5,
        });
    }

    /** One identity job at a time: the track whose last match is oldest (new tracks first). */
    #identityTick(bitmap: ImageBitmap, tMs: number, rotation: Rotation): void {
        const s = this.#cfg?.settings;
        if (!s?.identity || this.#idBusy) return;
        const wantPeople = this.#embedder.hasFace && this.#profiles.some((p) => p.kind !== "dog");
        const wantDogs = this.#embedder.hasDog && this.#profiles.some((p) => p.kind === "dog");
        type Job = { track: number; kind: "person" | "dog"; crop: () => Crop; since: number };
        const jobs: Job[] = [];
        if (wantPeople)
            for (const tr of this.#people.tracks) {
                const f = tr.data.face;
                if (!tr.visible || !f) continue;
                const since = this.#lastIdentity.get(tr.id) ?? -Infinity;
                if (tMs - since >= IDENTITY_INTERVAL_MS) jobs.push({ track: tr.id, kind: "person", since, crop: () => alignFace(bitmap, facePoints(f.raw, bitmap, rotation)) });
            }
        if (wantDogs)
            for (const tr of this.#dogs.tracks) {
                if (!tr.visible) continue;
                const since = this.#lastIdentity.get(tr.id) ?? -Infinity;
                const b = tr.data.box;
                if (tMs - since >= IDENTITY_INTERVAL_MS)
                    jobs.push({ track: tr.id, kind: "dog", since, crop: () => cropBox(bitmap, { x: b.x * bitmap.width, y: b.y * bitmap.height, w: b.w * bitmap.width, h: b.h * bitmap.height }) });
            }
        jobs.sort((a, b) => a.since - b.since);
        const job = jobs[0];
        if (!job) return;
        this.#lastIdentity.set(job.track, tMs);
        const crop = job.crop();
        this.#idBusy = true;
        const t0 = performance.now();
        const embed = job.kind === "dog" ? this.#embedder.dog(crop) : this.#embedder.face(crop);
        embed
            .then((e) => {
                ema(this.#timings, job.kind === "dog" ? "identity.dog" : "identity.face", performance.now() - t0);
                // The embedding of an unknown subject is dropped here; only the match result is kept.
                const m: Match | null = e ? matchProfile(e, job.kind, this.#profiles) : null;
                (job.kind === "dog" ? this.#dogVoter : this.#personVoter).vote(job.track, m);
            })
            .catch((err: unknown) => console.warn("[vision] identity failed", err))
            .finally(() => (this.#idBusy = false));
    }

    #enrolTick(bitmap: ImageBitmap): void {
        const job = this.#enrol;
        if (!job) return;
        const rotation = this.#cfg?.rotation ?? 0;
        let crop: Crop | null = null;
        let sizeScore = 0;
        if (job.kind === "person") {
            const best = [...this.#people.tracks].filter((tr) => tr.visible && tr.data.face).sort((a, b) => (b.data.face?.box.w ?? 0) - (a.data.face?.box.w ?? 0))[0];
            const f = best?.data.face;
            if (f) {
                crop = alignFace(bitmap, facePoints(f.raw, bitmap, rotation));
                sizeScore = Math.min(1, (rawBox(f.raw).w * bitmap.width) / 140);
            }
        } else {
            const best = [...this.#objects].filter((o) => o.label === "dog").sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
            if (best) {
                const b = best.box;
                crop = cropBox(bitmap, { x: b.x * bitmap.width, y: b.y * bitmap.height, w: b.w * bitmap.width, h: b.h * bitmap.height });
                sizeScore = Math.min(1, (Math.max(b.w * bitmap.width, b.h * bitmap.height)) / 220);
            }
        }
        if (!crop) {
            if (performance.now() > job.until) {
                this.#enrol = null;
                job.resolve(null);
            }
            return;
        }
        this.#enrol = null;
        const c = crop;
        const embed = job.kind === "dog" ? this.#embedder.dog(c) : this.#embedder.face(c);
        Promise.all([embed, thumbnail(c)])
            .then(([embedding, thumb]) => job.resolve(embedding ? { kind: job.kind, embedding, thumbnail: thumb, quality: Math.min(1, 0.6 * c.sharpness + 0.4 * sizeScore) } : null))
            .catch((e: unknown) => job.reject(e instanceof Error ? e : new Error(String(e))));
    }

    #faceBoxes(rotation: Rotation, mirror: boolean, uw: number, uh: number, swapEyes: boolean): FaceBox[] {
        const out: FaceBox[] = [];
        for (const tr of this.#people.tracks) {
            const f = tr.data.face;
            if (!tr.visible || !f) continue;
            const b = rawBox(f.raw);
            const li = at(f.raw, swapEyes ? FM.RIGHT_IRIS : FM.LEFT_IRIS);
            const ri = at(f.raw, swapEyes ? FM.LEFT_IRIS : FM.RIGHT_IRIS);
            const le: [number, number] = li ? [li.x, li.y] : [b.x + b.w * 0.65, b.y + b.h * 0.4];
            const re: [number, number] = ri ? [ri.x, ri.y] : [b.x + b.w * 0.35, b.y + b.h * 0.4];
            // Roll from the eye line on the DISPLAY (display-left eye -> display-right eye).
            const [lx, ly] = toDisplay(rotation, mirror, le[0], le[1], uw, uh);
            const [rx, ry] = toDisplay(rotation, mirror, re[0], re[1], uw, uh);
            const [ax, ay, bx, by] = lx <= rx ? [lx, ly, rx, ry] : [rx, ry, lx, ly];
            const m = this.#personVoter.current(tr.id);
            out.push({
                ...b,
                leftEye: le,
                rightEye: re,
                rollDeg: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI,
                track: tr.id,
                owner: tr.id === this.#ownerTrack,
                ...(m ? { name: m.name } : {}),
            });
        }
        return out;
    }

    #hints(tMs: number, families: ReadonlySet<SignalFamily>): GestureHint[] {
        const owner = this.#ownerTrack;
        if (owner === null) return [];
        const tr = this.#people.tracks.find((x) => x.id === owner);
        if (!tr?.visible) return [];
        const allowed = new Set([...HINT_FAMILIES].filter((f) => families.has(f)));
        return this.#signals
            .holds(tMs, allowed)
            .filter((h) => h.track === owner && !h.signal.startsWith("fingers_"))
            .map((h) => {
                const p = tr.data;
                const hand = p.hands.find((x) => x.side === h.hand) ?? (signalFamily(h.signal) !== "face" ? p.hands[0] : undefined);
                let atRaw: [number, number];
                if (hand) {
                    const c = rawBox(hand.raw);
                    atRaw = [c.x + c.w / 2, c.y + c.h / 2];
                } else if (p.face) {
                    const b = rawBox(p.face.raw);
                    atRaw = [b.x + b.w / 2, b.y];
                } else {
                    const n = p.pose?.[0];
                    atRaw = n ? [n.x, n.y] : [0.5, 0.5];
                }
                return { signal: h.signal, progress: h.progress, at: atRaw, ...(h.hand ? { hand: h.hand } : {}) };
            });
    }

    #frame(tMs: number, events: SignalEvent[], faces: FaceBox[], dogs: DogBox[], mask: VisionFrame["mask"], hints: GestureHint[], ownerDistanceM: number | undefined): VisionFrame {
        if (tMs - this.#lastSnapshot >= SNAPSHOT_MS) {
            this.#lastSnapshot = tMs;
            this.#snapshot = {
                at: Math.round(Date.now()),
                subjects: [
                    ...this.#people.tracks
                        .filter((tr) => tr.present)
                        .map((tr) => {
                            const st = this.#state.get(tr.id);
                            const m = this.#personVoter.current(tr.id);
                            return {
                                kind: "person" as const,
                                track: tr.id,
                                owner: tr.id === this.#ownerTrack,
                                ...(m ? { profileId: m.profileId, name: m.name } : {}),
                                ...(st?.distanceM !== undefined ? { distanceM: st.distanceM } : {}),
                                active: this.#signals.active(tr.id),
                                ...(st ? { energy: st.states.energy } : {}),
                            };
                        }),
                    ...this.#dogs.tracks
                        .filter((tr) => tr.present)
                        .map((tr) => {
                            const m = this.#dogVoter.current(tr.id);
                            return { kind: "dog" as const, track: tr.id, owner: false, ...(m ? { profileId: m.profileId, name: m.name } : {}), active: [] };
                        }),
                ],
                perf: { renderFps: 0, cameraFps: 0, visionMs: this.timings, vcamFps: 0 },
            };
        }
        const depth = this.#freshDepth;
        this.#freshDepth = null;
        const armed = this.#signals.isArmed(tMs);
        return {
            tMs,
            poses: this.#poses,
            mask,
            depth,
            faces,
            dogs,
            hints,
            events,
            snapshot: this.#snapshot,
            ...(ownerDistanceM !== undefined ? { ownerDistanceM } : {}),
            armed,
            timings: this.timings,
        };
    }
}

/**
 * Which MediaPipe wasm loader this context can run. tasks-vision 1.0.1 loads it
 * with a <script> tag (window), importScripts() (classic worker) or, when
 * importScripts throws a TypeError (module worker), with import(). The classic
 * loader defines `var ModuleFactory`, which only becomes a global in the first
 * two; a module worker needs the `_module_` variant that sets
 * globalThis.ModuleFactory. `importScripts()` with no arguments is a no-op in a
 * classic worker and throws in a module worker, so it is a safe probe.
 */
export function needsModuleLoader(): boolean {
    // The vision worker is an ES module in dev AND build (vite.config `worker.format: "es"`).
    // Probing with a zero-arg importScripts() does not throw in Chromium module workers
    // (measured 2026-10-06: "ModuleFactory not set." -> main-thread fallback, render 25 fps),
    // so the choice is made by context, not by probing.
    return typeof document === "undefined";
}

function pulse(signal: SignalId, tMs: number, subject: Subject): SignalEvent {
    return { signal, phase: "pulse", at: Math.round(tMs), confidence: 0.9, subject };
}

function ipdPx(faceDisp: readonly Pt[]): number {
    const l = faceDisp[FM.LEFT_IRIS];
    const r = faceDisp[FM.RIGHT_IRIS];
    return l && r ? Math.hypot(l.x - r.x, l.y - r.y) : 0;
}

/** The five ArcFace points in BITMAP pixels, ordered by upright (unmirrored) x like the template. */
function facePoints(raw: readonly NormalizedLandmark[], bitmap: ImageBitmap, rotation: Rotation) {
    const px = (i: number): [number, number] => {
        const p = raw[i] ?? { x: 0, y: 0 };
        return [p.x * bitmap.width, p.y * bitmap.height];
    };
    const ux = (p: [number, number]) => toUpright(rotation, p[0] / bitmap.width, p[1] / bitmap.height)[0];
    return orderFacePoints(px(FM.LEFT_IRIS), px(FM.RIGHT_IRIS), px(FM.NOSE_TIP), px(FM.MOUTH_LEFT), px(FM.MOUTH_RIGHT), ux);
}
