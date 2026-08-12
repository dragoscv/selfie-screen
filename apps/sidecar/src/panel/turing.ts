import { SerialPort } from "serialport";

import { logger } from "../logger.js";

const log = logger.scoped("[panel]");

export const PANEL_WIDTH = 320;
export const PANEL_HEIGHT = 480;

/** CH340-alike VID/PID pairs used by Turing "revision A" 3.5" panels. */
const PANEL_IDS: ReadonlyArray<{ vid: string; pid: string }> = [
    { vid: "1A86", pid: "CA21" },
    { vid: "1A86", pid: "5722" },
];

const CMD_CLEAR = 102;
const CMD_SCREEN_OFF = 108;
const CMD_SCREEN_ON = 109;
const CMD_SET_BRIGHTNESS = 110;
const CMD_SET_ORIENTATION = 121;
const CMD_DISPLAY_BITMAP = 197;

/** Clean row runs shorter than this get absorbed into one rectangle. */
const GAP_TOLERANCE = 12;

export interface PanelPortInfo {
    path: string;
    manufacturer?: string;
    vendorId?: string;
    productId?: string;
    isPanel: boolean;
}

function isPanelId(vendorId?: string, productId?: string): boolean {
    if (!vendorId || !productId) return false;
    const vid = vendorId.toUpperCase();
    const pid = productId.toUpperCase();
    return PANEL_IDS.some((id) => id.vid === vid && id.pid === pid);
}

export async function listPorts(): Promise<PanelPortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        vendorId: p.vendorId,
        productId: p.productId,
        isPanel: isPanelId(p.vendorId, p.productId),
    }));
}

/** First port whose USB IDs match a known panel. */
export async function findPanelPort(): Promise<string | null> {
    const ports = await listPorts();
    return ports.find((p) => p.isPanel)?.path ?? null;
}

/**
 * Driver for the Turing Smart Screen 320×480 panel.
 *
 * On Android this device is spoken to over raw USB bulk transfers, because it
 * advertises CH340 IDs but rejects genuine CH34x control transfers. On Windows
 * it enumerates as a plain serial port, so the same 6-byte command protocol and
 * RGB565 framebuffer travel over `serialport` instead. Baud rate is irrelevant
 * — it is a native USB device.
 */
export class TuringPanel {
    #port: SerialPort | null = null;
    #path: string;
    /** Previous frame in RGB565, for dirty-region diffing. */
    #last: Uint16Array | null = null;
    #frames = 0;
    #writing: Promise<void> = Promise.resolve();

    constructor(path: string) {
        this.#path = path;
    }

    get path(): string {
        return this.#path;
    }

    get frames(): number {
        return this.#frames;
    }

    get connected(): boolean {
        return this.#port?.isOpen === true;
    }

    async open(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const port = new SerialPort(
                { path: this.#path, baudRate: 115_200, autoOpen: false },
                (error) => {
                    if (error) reject(error);
                },
            );
            port.open((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                this.#port = port;
                resolve();
            });
            port.on("error", (error) => log.warn("serial error", error.message));
        });

        // Panels occasionally come up mid-frame; a clear plus a known orientation
        // puts us in a defined state before the first push.
        await this.#command(CMD_CLEAR);
        await this.setOrientationPortrait();
        await this.screenOn();
        this.#last = null;
        log.info(`panel opened on ${this.#path}`);
    }

    async close(): Promise<void> {
        const port = this.#port;
        this.#port = null;
        this.#last = null;
        if (!port?.isOpen) return;
        await new Promise<void>((resolve) => port.close(() => resolve()));
        log.info("panel closed");
    }

    /** Serialise writes: interleaved commands would corrupt the framebuffer. */
    #write(data: Buffer): Promise<void> {
        const port = this.#port;
        if (!port?.isOpen) return Promise.reject(new Error("Panel is not open"));

        this.#writing = this.#writing.then(
            () =>
                new Promise<void>((resolve, reject) => {
                    port.write(data, (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
                    });
                }),
        );
        return this.#writing;
    }

    /**
     * The panel's 6-byte command word packs a command id and a bounding box into
     * 40 bits. Layout ported verbatim from the Android driver.
     */
    #command(cmd: number, x = 0, y = 0, ex = 0, ey = 0): Promise<void> {
        const buf = Buffer.alloc(6);
        buf[0] = x >> 2;
        buf[1] = ((x & 3) << 6) + (y >> 4);
        buf[2] = ((y & 15) << 4) + (ex >> 6);
        buf[3] = ((ex & 63) << 2) + (ey >> 8);
        buf[4] = ey & 255;
        buf[5] = cmd;
        return this.#write(buf);
    }

    /** `level` is 0..100; the panel's own scale is inverted (0 = brightest). */
    setBrightness(level: number): Promise<void> {
        const clamped = Math.min(100, Math.max(0, Math.round(level)));
        return this.#command(CMD_SET_BRIGHTNESS, Math.round(255 - (clamped / 100) * 255));
    }

    setOrientationPortrait(reverse = false): Promise<void> {
        const buf = Buffer.alloc(16);
        buf[5] = CMD_SET_ORIENTATION;
        buf[6] = (reverse ? 1 : 0) + 100;
        buf[7] = PANEL_WIDTH >> 8;
        buf[8] = PANEL_WIDTH & 255;
        buf[9] = PANEL_HEIGHT >> 8;
        buf[10] = PANEL_HEIGHT & 255;
        return this.#write(buf);
    }

    screenOn(): Promise<void> {
        return this.#command(CMD_SCREEN_ON);
    }

    screenOff(): Promise<void> {
        return this.#command(CMD_SCREEN_OFF);
    }

    clear(): Promise<void> {
        this.#last = null;
        return this.#command(CMD_CLEAR);
    }

    /**
     * Push a full RGBA frame (320×480×4). Only changed regions travel over the
     * wire: a full repaint is ~300KB, which at 115200-equivalent throughput
     * would cap the panel at a fraction of a frame per second.
     *
     * Returns the number of bytes actually written.
     */
    async display(rgba: Uint8ClampedArray | Uint8Array): Promise<number> {
        if (!this.connected) return 0;

        const expected = PANEL_WIDTH * PANEL_HEIGHT * 4;
        if (rgba.length < expected) {
            throw new Error(`Frame too small: ${rgba.length} < ${expected}`);
        }

        const current = toRgb565(rgba);
        const previous = this.#last;
        let written = 0;

        if (!previous) {
            written += await this.#pushRect(current, 0, 0, PANEL_WIDTH - 1, PANEL_HEIGHT - 1);
        } else {
            // Independent runs of dirty rows are pushed as separate rectangles. A
            // single bounding band was pathological: a clock at the top plus a new
            // message at the bottom dirtied the whole screen every second.
            let runStart = -1;
            let y = 0;
            while (y <= PANEL_HEIGHT) {
                const dirty = y < PANEL_HEIGHT && !rowEquals(current, previous, y);
                if (dirty) {
                    if (runStart < 0) runStart = y;
                } else if (runStart >= 0) {
                    // Coalesce across short clean gaps — an extra command plus a USB
                    // round-trip costs more than re-sending a few identical rows.
                    const nextDirty = findNextDirty(current, previous, y);
                    if (nextDirty < PANEL_HEIGHT && nextDirty - y < GAP_TOLERANCE) {
                        y = nextDirty;
                        continue;
                    }
                    written += await this.#pushRun(current, runStart, y - 1);
                    runStart = -1;
                }
                y += 1;
            }
        }

        this.#last = current;
        if (written > 0) this.#frames += 1;
        return written;
    }

    /** Narrow a dirty row run to the columns that actually moved, then push. */
    async #pushRun(frame: Uint16Array, y0: number, y1: number): Promise<number> {
        let x0 = PANEL_WIDTH;
        let x1 = -1;
        const previous = this.#last;

        for (let y = y0; y <= y1; y += 1) {
            const base = y * PANEL_WIDTH;
            for (let x = 0; x < x0; x += 1) {
                if (!previous || frame[base + x] !== previous[base + x]) {
                    x0 = x;
                    break;
                }
            }
            for (let x = PANEL_WIDTH - 1; x > x1; x -= 1) {
                if (!previous || frame[base + x] !== previous[base + x]) {
                    x1 = x;
                    break;
                }
            }
        }

        if (x1 < x0) return 0;
        return this.#pushRect(frame, x0, y0, x1, y1);
    }

    async #pushRect(
        frame: Uint16Array,
        x0: number,
        y0: number,
        x1: number,
        y1: number,
    ): Promise<number> {
        const width = x1 - x0 + 1;
        const height = y1 - y0 + 1;
        const payload = Buffer.alloc(width * height * 2);

        let offset = 0;
        for (let y = y0; y <= y1; y += 1) {
            const base = y * PANEL_WIDTH;
            for (let x = x0; x <= x1; x += 1) {
                // Panel expects big-endian RGB565.
                payload.writeUInt16BE(frame[base + x] ?? 0, offset);
                offset += 2;
            }
        }

        await this.#command(CMD_DISPLAY_BITMAP, x0, y0, x1, y1);
        // Chunked so a single huge write cannot stall the serial driver.
        for (let i = 0; i < payload.length; i += 16_384) {
            await this.#write(payload.subarray(i, Math.min(i + 16_384, payload.length)));
        }
        return payload.length;
    }
}

/** Pack RGBA8888 into RGB565, the panel's native pixel format. */
export function toRgb565(rgba: Uint8ClampedArray | Uint8Array): Uint16Array {
    const out = new Uint16Array(PANEL_WIDTH * PANEL_HEIGHT);
    for (let i = 0, p = 0; p < out.length; i += 4, p += 1) {
        const r = rgba[i] ?? 0;
        const g = rgba[i + 1] ?? 0;
        const b = rgba[i + 2] ?? 0;
        out[p] = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
    }
    return out;
}

function rowEquals(a: Uint16Array, b: Uint16Array, y: number): boolean {
    const base = y * PANEL_WIDTH;
    for (let x = 0; x < PANEL_WIDTH; x += 1) {
        if (a[base + x] !== b[base + x]) return false;
    }
    return true;
}

function findNextDirty(a: Uint16Array, b: Uint16Array, from: number): number {
    let y = from;
    while (y < PANEL_HEIGHT && rowEquals(a, b, y)) y += 1;
    return y;
}
