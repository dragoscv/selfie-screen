package ro.codai.selfiescreen

import android.graphics.Bitmap
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import java.io.IOException

/**
 * Driver for Turing Smart Screen "revision A" 3.5" panels (320x480, TURZX).
 * Kotlin port of the serial protocol used in circus/apps/screen/lcd.py
 * (itself derived from mathoudebine/turing-smart-screen-python).
 *
 * The panel advertises CH340 VID/PID but is a custom MCU that REJECTS real
 * CH34x init control transfers, so we talk raw USB bulk instead of using a
 * serial driver. Baud rate is irrelevant (native USB device).
 */
class TuringLcd(
    private val device: UsbDevice,
    private val connection: UsbDeviceConnection,
) {

    companion object {
        const val WIDTH = 320
        const val HEIGHT = 480

        private const val CMD_RESET = 101
        private const val CMD_CLEAR = 102
        private const val CMD_SCREEN_OFF = 108
        private const val CMD_SCREEN_ON = 109
        private const val CMD_SET_BRIGHTNESS = 110
        private const val CMD_SET_ORIENTATION = 121
        private const val CMD_DISPLAY_BITMAP = 197

        private const val WRITE_TIMEOUT_MS = 5000

        /** Clean row-runs shorter than this get absorbed into one rectangle. */
        private const val GAP_TOLERANCE = 12
    }

    private val iface: UsbInterface
    private val epOut: UsbEndpoint
    private val epIn: UsbEndpoint?

    init {
        var foundIface: UsbInterface? = null
        var foundOut: UsbEndpoint? = null
        var foundIn: UsbEndpoint? = null
        outer@ for (i in 0 until device.interfaceCount) {
            val intf = device.getInterface(i)
            var out: UsbEndpoint? = null
            var inp: UsbEndpoint? = null
            for (e in 0 until intf.endpointCount) {
                val ep = intf.getEndpoint(e)
                if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                    if (ep.direction == UsbConstants.USB_DIR_OUT) out = ep else inp = ep
                }
            }
            if (out != null) {
                foundIface = intf; foundOut = out; foundIn = inp
                break@outer
            }
        }
        iface = foundIface ?: throw IOException("No bulk-out interface on panel")
        epOut = foundOut!!
        epIn = foundIn
        if (!connection.claimInterface(iface, true)) throw IOException("claimInterface failed")
    }

    private fun write(data: ByteArray, timeout: Int = WRITE_TIMEOUT_MS) {
        var off = 0
        while (off < data.size) {
            val len = minOf(16384, data.size - off)
            val sent = connection.bulkTransfer(epOut, data, off, len, timeout)
            if (sent < 0) throw IOException("bulkTransfer failed at offset $off")
            off += sent
        }
    }

    private val cmdBuf = ByteArray(6)

    @Synchronized
    private fun command(cmd: Int, x: Int = 0, y: Int = 0, ex: Int = 0, ey: Int = 0) {
        cmdBuf[0] = (x shr 2).toByte()
        cmdBuf[1] = (((x and 3) shl 6) + (y shr 4)).toByte()
        cmdBuf[2] = (((y and 15) shl 4) + (ex shr 6)).toByte()
        cmdBuf[3] = (((ex and 63) shl 2) + (ey shr 8)).toByte()
        cmdBuf[4] = (ey and 255).toByte()
        cmdBuf[5] = cmd.toByte()
        write(cmdBuf)
    }

    /** Hello handshake; panel may or may not reply. */
    fun initialize() {
        val hello = ByteArray(6) { 69 }
        write(hello)
        epIn?.let {
            val resp = ByteArray(it.maxPacketSize)
            connection.bulkTransfer(it, resp, resp.size, 250)
        }
    }

    /** level 0..100 (panel scale is inverted: 0 = brightest). */
    fun setBrightness(level: Int) {
        val clamped = level.coerceIn(0, 100)
        val absolute = (255 - clamped / 100.0 * 255).toInt()
        command(CMD_SET_BRIGHTNESS, absolute)
    }

    fun setOrientationPortrait(reverse: Boolean = false) {
        val buf = ByteArray(16)
        buf[5] = CMD_SET_ORIENTATION.toByte()
        buf[6] = ((if (reverse) 1 else 0) + 100).toByte()
        buf[7] = (WIDTH shr 8).toByte()
        buf[8] = (WIDTH and 255).toByte()
        buf[9] = (HEIGHT shr 8).toByte()
        buf[10] = (HEIGHT and 255).toByte()
        write(buf)
    }

    fun screenOn() = command(CMD_SCREEN_ON)
    fun screenOff() = command(CMD_SCREEN_OFF)

    private val rgb565 = ByteArray(WIDTH * HEIGHT * 2)
    private val pixelBuf = IntArray(WIDTH * HEIGHT)
    private val lastPixels = IntArray(WIDTH * HEIGHT) { -1 }
    private var lastValid = false

    /**
     * Push a full 320x480 portrait frame. Bitmap must already be 320x480.
     * Returns elapsed ms.
     */
    fun display(frame: Bitmap): Long {
        val start = System.nanoTime()
        frame.getPixels(pixelBuf, 0, WIDTH, 0, 0, WIDTH, HEIGHT)

        if (!lastValid) {
            pushRect(0, 0, WIDTH - 1, HEIGHT - 1)
            System.arraycopy(pixelBuf, 0, lastPixels, 0, pixelBuf.size)
            lastValid = true
            return (System.nanoTime() - start) / 1_000_000
        }

        // Multi-region diff. A single contiguous band was pathological: the
        // seconds clock at the top plus a new message at the bottom dirtied
        // ~the whole screen every second — that was the slow top-to-bottom
        // repaint. Now each independent run of changed rows is pushed as its
        // own rectangle, narrowed to the columns that actually moved.
        var runStart = -1
        var pushed = 0
        var y = 0
        while (y <= HEIGHT) {
            val dirty = y < HEIGHT && !rowEquals(y)
            if (dirty) {
                if (runStart < 0) runStart = y
            } else if (runStart >= 0) {
                // Coalesce across short clean gaps: an extra command + USB
                // round-trip costs more than re-sending a few identical rows.
                val nextDirty = findNextDirty(y)
                if (nextDirty < HEIGHT && nextDirty - y < GAP_TOLERANCE) {
                    y = nextDirty
                    continue
                }
                pushRun(runStart, y - 1)
                pushed++
                runStart = -1
            }
            y++
        }
        if (pushed == 0) return 0 // identical frame
        return (System.nanoTime() - start) / 1_000_000
    }

    /** First dirty row at or after [from], or HEIGHT when none remain. */
    private fun findNextDirty(from: Int): Int {
        var y = from
        while (y < HEIGHT && rowEquals(y)) y++
        return y
    }

    /**
     * Push rows [y0]..[y1], narrowed to the horizontal span that changed, and
     * refresh the cache for exactly those pixels.
     */
    private fun pushRun(y0: Int, y1: Int) {
        var x0 = WIDTH
        var x1 = -1
        for (y in y0..y1) {
            val base = y * WIDTH
            var x = 0
            while (x < x0) {
                if (pixelBuf[base + x] != lastPixels[base + x]) { x0 = x; break }
                x++
            }
            x = WIDTH - 1
            while (x > x1) {
                if (pixelBuf[base + x] != lastPixels[base + x]) { x1 = x; break }
                x--
            }
        }
        if (x1 < x0) return
        pushRect(x0, y0, x1, y1)
        for (y in y0..y1) {
            val base = y * WIDTH
            System.arraycopy(pixelBuf, base + x0, lastPixels, base + x0, x1 - x0 + 1)
        }
    }

    /** Convert and stream one inclusive rectangle to the panel. */
    private fun pushRect(x0: Int, y0: Int, x1: Int, y1: Int) {
        val w = x1 - x0 + 1
        var o = 0
        for (y in y0..y1) {
            val base = y * WIDTH + x0
            for (i in 0 until w) {
                val p = pixelBuf[base + i]
                val r = (p shr 16) and 0xFF
                val g = (p shr 8) and 0xFF
                val b = p and 0xFF
                val v = ((r and 0xF8) shl 8) or ((g and 0xFC) shl 3) or (b shr 3)
                rgb565[o++] = (v and 0xFF).toByte()
                rgb565[o++] = ((v shr 8) and 0xFF).toByte()
            }
        }
        synchronized(this) {
            command(CMD_DISPLAY_BITMAP, x0, y0, x1, y1)
            var i = 0
            while (i < o) {
                val len = minOf(16384, o - i)
                val sent = connection.bulkTransfer(epOut, rgb565, i, len, WRITE_TIMEOUT_MS)
                if (sent < 0) throw IOException("frame write failed at $i")
                i += sent
            }
        }
    }

    private fun rowEquals(y: Int): Boolean {
        val base = y * WIDTH
        for (x in 0 until WIDTH) {
            if (pixelBuf[base + x] != lastPixels[base + x]) return false
        }
        return true
    }

    /** Force the next frame to be pushed in full. */
    fun invalidateCache() {
        lastValid = false
    }

    fun close() {
        try {
            connection.releaseInterface(iface)
            connection.close()
        } catch (_: Exception) {
        }
    }
}
