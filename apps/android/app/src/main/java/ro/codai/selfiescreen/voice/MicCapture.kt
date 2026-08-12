package ro.codai.selfiescreen.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Push-to-talk mic capture: 24 kHz mono PCM16 chunks streamed to the realtime
 * session while the button is held.
 */
class MicCapture(
    private val onChunk: (ByteArray, Int) -> Unit,
    private val onLevel: (Float) -> Unit = {},
) {
    companion object {
        private const val TAG = "MicCapture"
        private const val SAMPLE_RATE = 24000
    }

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private val running = AtomicBoolean(false)

    @SuppressLint("MissingPermission")
    fun start() {
        if (running.get()) return
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        val bufSize = maxOf(minBuf * 2, SAMPLE_RATE / 5)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, bufSize
            )
        } catch (e: SecurityException) {
            Log.w(TAG, "mic permission missing"); return
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            Log.w(TAG, "AudioRecord init failed"); rec.release(); return
        }
        record = rec
        running.set(true)
        rec.startRecording()
        thread = Thread {
            val buf = ByteArray(bufSize)
            while (running.get()) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) {
                    onChunk(buf, n)
                    onLevel(level(buf, n))
                }
            }
        }.also { it.isDaemon = true; it.start() }
    }

    fun stop() {
        running.set(false)
        thread?.join(500)
        thread = null
        try {
            record?.stop(); record?.release()
        } catch (_: Exception) {
        }
        record = null
        onLevel(0f)
    }

    private fun level(buf: ByteArray, n: Int): Float {
        var sum = 0L
        var i = 0
        var count = 0
        while (i + 1 < n) {
            val s = ((buf[i + 1].toInt() shl 8) or (buf[i].toInt() and 0xFF)).toShort().toInt()
            sum += kotlin.math.abs(s).toLong()
            i += 32
            count++
        }
        if (count == 0) return 0f
        return ((sum.toDouble() / count) / 8000.0).coerceIn(0.0, 1.0).toFloat()
    }
}
