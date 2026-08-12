package ro.codai.selfiescreen.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/** Live audio state, consumed by the panel renderer + UI. */
data class SpeakingState(
    val speaking: Boolean = false,
    /** Id of the ChatMessage currently being voiced (message.at), 0 if none. */
    val currentId: Long = 0,
    val currentText: String = "",
    /** 0..1 output level for the waveform. */
    val level: Float = 0f,
    val connected: Boolean = false,
    val error: String? = null,
)

/** Cumulative usage for the cost meter. */
data class UsageTotals(
    val textIn: Long = 0,
    val audioIn: Long = 0,
    val textOut: Long = 0,
    val audioOut: Long = 0,
) {
    /**
     * gpt-realtime-2.1 (2026-07) list prices, USD per 1M tokens.
     * text in 4 / audio in 32 / text out 16 / audio out 64.
     */
    val estimatedUsd: Double
        get() = textIn / 1e6 * 4 + audioIn / 1e6 * 32 + textOut / 1e6 * 16 + audioOut / 1e6 * 64
}

/**
 * One realtime WebSocket session against Azure AI Foundry (gpt-realtime).
 * Streams PCM16 24kHz audio to an [AudioTrack] as deltas arrive, so speech
 * starts within a few hundred ms rather than after full synthesis.
 */
class RealtimeClient(
    private val endpoint: String,
    private val apiKey: String,
    private val deployment: String,
) {
    companion object {
        private const val TAG = "RealtimeClient"
        private const val SAMPLE_RATE = 24000
    }

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var ws: WebSocket? = null
    private var track: AudioTrack? = null
    private val closing = AtomicBoolean(false)

    val state = MutableStateFlow(SpeakingState())
    val usage = MutableStateFlow(UsageTotals())

    /** Called with the assistant's transcript as it streams (for the UI). */
    var onTranscript: ((String) -> Unit)? = null
    var onResponseDone: (() -> Unit)? = null
    /** Fired when the user's push-to-talk speech is transcribed. */
    var onUserTranscript: ((String) -> Unit)? = null

    private var pendingId: Long = 0
    private var pendingText: String = ""

    fun connect(sessionConfig: JsonObject) {
        closing.set(false)
        val url = "wss://$endpoint/openai/v1/realtime?model=$deployment"
        val request = Request.Builder().url(url).addHeader("api-key", apiKey).build()
        ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "connected to $deployment")
                state.value = state.value.copy(connected = true, error = null)
                send(buildJsonObject {
                    put("type", "session.update")
                    put("session", sessionConfig)
                })
            }

            override fun onMessage(webSocket: WebSocket, text: String) = handleEvent(text)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (closing.get()) return
                Log.e(TAG, "ws failure: ${t.message}")
                state.value = state.value.copy(
                    connected = false, speaking = false,
                    error = t.message ?: "connection failed",
                )
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                state.value = state.value.copy(connected = false, speaking = false)
            }
        })
    }

    fun close() {
        closing.set(true)
        ws?.close(1000, "bye")
        ws = null
        releaseTrack()
        state.value = SpeakingState()
    }

    fun send(obj: JsonObject) {
        ws?.send(json.encodeToString(JsonObject.serializer(), obj))
    }

    /** Speak [text] verbatim; [id] links playback back to the source message. */
    fun speak(text: String, id: Long, voiceInstructions: String? = null) {
        pendingId = id
        pendingText = text
        send(buildJsonObject {
            put("type", "response.create")
            putJsonObject("response") {
                put("instructions", buildString {
                    append(voiceInstructions ?: "Read the following text aloud verbatim, naturally. Do not add or omit words.")
                    append("\n\nTEXT:\n")
                    append(text)
                })
            }
        })
    }

    /** Ask the assistant to respond conversationally (AI replies / idle chatter). */
    fun respond(instructions: String, id: Long = 0, contextText: String = "") {
        pendingId = id
        pendingText = contextText
        send(buildJsonObject {
            put("type", "response.create")
            putJsonObject("response") { put("instructions", instructions) }
        })
    }

    /** Add a conversation turn without triggering a response (context building). */
    fun addContext(role: String, text: String) {
        send(buildJsonObject {
            put("type", "conversation.item.create")
            putJsonObject("item") {
                put("type", "message")
                put("role", role)
                putJsonArray("content") {
                    add(buildJsonObject {
                        put("type", if (role == "assistant") "output_text" else "input_text")
                        put("text", text)
                    })
                }
            }
        })
    }

    /** Stop the current utterance immediately. */
    fun cancel() {
        send(buildJsonObject { put("type", "response.cancel") })
        track?.pause()
        track?.flush()
        track?.play()
        state.value = state.value.copy(speaking = false, currentId = 0, currentText = "", level = 0f)
    }

    // ---- Push-to-talk mic input ----

    fun appendAudio(pcm16: ByteArray, length: Int) {
        val b64 = Base64.encodeToString(pcm16.copyOf(length), Base64.NO_WRAP)
        send(buildJsonObject {
            put("type", "input_audio_buffer.append")
            put("audio", b64)
        })
    }

    fun commitAudio() {
        send(buildJsonObject { put("type", "input_audio_buffer.commit") })
    }

    // ---- Event handling ----

    private fun handleEvent(raw: String) {
        val obj = try {
            json.parseToJsonElement(raw).jsonObject
        } catch (e: Exception) {
            return
        }
        when (obj["type"]?.jsonPrimitive?.content) {
            "response.output_audio.delta" -> {
                val b64 = obj["delta"]?.jsonPrimitive?.content ?: return
                val pcm = Base64.decode(b64, Base64.DEFAULT)
                ensureTrack()
                track?.write(pcm, 0, pcm.size)
                state.value = state.value.copy(
                    speaking = true,
                    currentId = pendingId,
                    currentText = pendingText,
                    level = rms(pcm),
                )
            }
            "response.output_audio_transcript.delta" -> {
                obj["delta"]?.jsonPrimitive?.content?.let { onTranscript?.invoke(it) }
            }
            "conversation.item.input_audio_transcription.completed" -> {
                obj["transcript"]?.jsonPrimitive?.content?.let { onUserTranscript?.invoke(it) }
            }
            "response.done" -> {
                obj["response"]?.jsonObject?.get("usage")?.jsonObject?.let(::accumulateUsage)
                state.value = state.value.copy(
                    speaking = false, currentId = 0, currentText = "", level = 0f,
                )
                onResponseDone?.invoke()
            }
            "error" -> {
                val msg = obj["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content
                Log.w(TAG, "server error: $msg")
                state.value = state.value.copy(error = msg)
            }
        }
    }

    private fun accumulateUsage(u: JsonObject) {
        fun tokens(section: String, kind: String): Long =
            u[section]?.jsonObject?.get("${kind}_tokens")?.jsonPrimitive?.content?.toLongOrNull() ?: 0

        val cur = usage.value
        usage.value = cur.copy(
            textIn = cur.textIn + tokens("input_token_details", "text"),
            audioIn = cur.audioIn + tokens("input_token_details", "audio"),
            textOut = cur.textOut + tokens("output_token_details", "text"),
            audioOut = cur.audioOut + tokens("output_token_details", "audio"),
        )
    }

    private fun rms(pcm: ByteArray): Float {
        var sum = 0.0
        var i = 0
        var n = 0
        while (i + 1 < pcm.size) {
            val s = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xFF)).toShort().toInt()
            sum += abs(s).toDouble()
            i += 64 // sample sparsely; this is only a VU indicator
            n++
        }
        if (n == 0) return 0f
        return ((sum / n) / 8000.0).coerceIn(0.0, 1.0).toFloat()
    }

    // ---- Audio output ----

    var usageStream: Int = AudioManager.STREAM_MUSIC
    var outputVolume: Float = 1.0f
        set(value) {
            field = value.coerceIn(0f, 1f)
            track?.setVolume(field)
        }

    private fun ensureTrack() {
        if (track != null) return
        val minBuf = AudioTrack.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(minBuf * 4, SAMPLE_RATE)) // ~0.5s cushion
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
            .also {
                it.setVolume(outputVolume)
                it.play()
            }
    }

    private fun releaseTrack() {
        try {
            track?.pause(); track?.flush(); track?.release()
        } catch (_: Exception) {
        }
        track = null
    }
}
