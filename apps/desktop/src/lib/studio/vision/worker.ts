import { VisionPipeline } from "./pipeline.js";
import type { FromWorker, ToWorker } from "./protocol.js";

/**
 * Vision worker. Loaded by runtime.ts with
 * `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`:
 * Vite dev serves it as an ES module worker, `vite build` bundles it as IIFE
 * (worker.format default) = a classic worker. The pipeline probes which one it
 * is and picks the matching MediaPipe wasm loader (see needsModuleLoader).
 */
/** The bits of DedicatedWorkerGlobalScope we use (the "webworker" lib clashes with the app's DOM lib). */
interface WorkerScope {
    postMessage(message: unknown, transfer: Transferable[]): void;
    onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
    close(): void;
}
const scope = self as unknown as WorkerScope;
const pipeline = new VisionPipeline();
let busy = false;

function reply(msg: FromWorker, transfer: Transferable[] = []): void {
    scope.postMessage(msg, transfer);
}

function fail(id: number, e: unknown): void {
    reply({ id, type: "error", message: e instanceof Error ? e.message : String(e) });
}

scope.onmessage = (ev: MessageEvent<ToWorker>) => {
    const m = ev.data;
    switch (m.type) {
        case "init":
            pipeline.init(m.config).then(() => reply({ id: m.id, type: "ok" }), (e: unknown) => fail(m.id, e));
            return;
        case "apply":
            pipeline.apply(m.config).then(() => reply({ id: m.id, type: "ok" }), (e: unknown) => fail(m.id, e));
            return;
        case "frame":
            if (busy) {
                m.bitmap.close();
                reply({ id: m.id, type: "ok" });
                return;
            }
            busy = true;
            pipeline.onPose = (tMs, poses, ownerIndex) => reply({ id: m.id, type: "pose", tMs, poses, ownerIndex });
            pipeline
                .process(m.bitmap, m.tMs, m.rawW, m.rawH)
                .then(
                    (frame) => {
                        const transfer: Transferable[] = [];
                        if (frame.mask) transfer.push(frame.mask.data.buffer);
                        if (frame.depth) transfer.push(frame.depth.data.buffer);
                        reply({ id: m.id, type: "frame", frame }, transfer);
                    },
                    (e: unknown) => fail(m.id, e),
                )
                .finally(() => (busy = false));
            return;
        case "calibrate":
            pipeline.calibrate(m.ms).then((sample) => reply({ id: m.id, type: "calibration", sample }), (e: unknown) => fail(m.id, e));
            return;
        case "enrol":
            pipeline.enrol(m.kind).then((sample) => reply({ id: m.id, type: "enrolment", sample }), (e: unknown) => fail(m.id, e));
            return;
        case "models":
            pipeline
                .ensureModels(m.which, (progress) => reply({ id: m.id, type: "progress", progress }))
                .then(() => reply({ id: m.id, type: "ok" }), (e: unknown) => fail(m.id, e));
            return;
        case "profiles":
            pipeline.setProfiles(m.profiles);
            reply({ id: m.id, type: "ok" });
            return;
        case "close":
            pipeline.close();
            reply({ id: m.id, type: "ok" });
            scope.close();
            return;
    }
};
