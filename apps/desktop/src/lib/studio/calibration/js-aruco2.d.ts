// js-aruco2 2.0.0 (MIT) ships plain CommonJS without types; only the surface charuco.ts uses.
declare module "js-aruco2" {
    export interface ArPoint {
        x: number;
        y: number;
    }
    export interface ArMarker {
        id: number;
        corners: ArPoint[];
        hammingDistance: number;
    }
    export interface ArDictionarySpec {
        nBits: number;
        tau: number | null;
        codeList: (number | string | number[])[];
    }
    export interface ArImage {
        width: number;
        height: number;
        data: Uint8ClampedArray | Uint8Array | number[];
    }
    export class Detector {
        constructor(config?: { dictionaryName?: string; maxHammingDistance?: number });
        detectImage(width: number, height: number, data: Uint8ClampedArray | Uint8Array): ArMarker[];
        /** Grey image of the last detect call (same size as the input). */
        grey: ArImage;
    }
    export const AR: {
        DICTIONARIES: Record<string, ArDictionarySpec>;
        Detector: typeof Detector;
    };
}
