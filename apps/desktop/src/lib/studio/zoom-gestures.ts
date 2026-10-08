/** Lazy chunk: the zoom gesture controllers, loaded once the engine starts. */
import { IndexDial } from "./index-dial.js";
import { PinchZoom } from "./pinch-zoom.js";
import { ZoomDriver } from "./zoom-driver.js";

export interface ZoomGestures {
    pinch: PinchZoom;
    dial: IndexDial;
    driver: ZoomDriver;
}

export function createZoomGestures(): ZoomGestures {
    return { pinch: new PinchZoom(), dial: new IndexDial(), driver: new ZoomDriver() };
}