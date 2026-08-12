package ro.codai.selfiescreen.voice

import android.content.Context
import android.media.AudioManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import ro.codai.selfiescreen.ChatMessage
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** An item waiting to be voiced. */
data class QueueItem(
    val id: Long,
    val user: String,
    val speakText: String,
    val kind: ChatMessage.Kind,
    val priority: Int,
    val aiReply: Boolean = false,
)

data class AssistantStats(
    val spoken: Int = 0,
    val skipped: Int = 0,
    val queued: Int = 0,
    val uniqueViewers: Int = 0,
    val giftsSeen: Int = 0,
    val sessionStart: Long = System.currentTimeMillis(),
    val lastTranscript: String = "",
)

/**
 * Orchestrates everything voice: filters + prioritises incoming chat, keeps a
 * bounded speech queue, remembers people across lives, produces AI replies
 * with live context, and drives idle chatter when the room goes quiet.
 */
class VoiceAssistant(
    private val context: Context,
    private val settings: VoiceSettings,
) {
    companion object {
        private const val TAG = "VoiceAssistant"
        private const val PRIORITY_GIFT = 0
        private const val PRIORITY_AI = 1
        private const val PRIORITY_FOLLOW = 2
        private const val PRIORITY_CHAT = 3
        private const val PRIORITY_AMBIENT = 4
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val dao = MemoryDb.get(context).dao()
    private val sessionId = UUID.randomUUID().toString()

    private var tts: RealtimeClient? = null
    private var ai: RealtimeClient? = null
    private var config: VoiceConfig = VoiceConfig()

    private val queue = ArrayDeque<QueueItem>()
    private val recentTexts = ArrayDeque<String>()
    private val speaking = AtomicBoolean(false)
    private var pumpJob: Job? = null
    private var idleJob: Job? = null
    private var lastActivity = System.currentTimeMillis()

    val state = MutableStateFlow(SpeakingState())
    val usage = MutableStateFlow(UsageTotals())
    val stats = MutableStateFlow(AssistantStats())
    /** Snapshot of the queue for the UI. */
    val pending = MutableStateFlow<List<QueueItem>>(emptyList())

    val isRunning: Boolean get() = tts != null

    // ---------- lifecycle ----------

    fun start(cfg: VoiceConfig) {
        if (tts != null) {
            applyConfig(cfg)
            return
        }
        config = cfg
        if (!settings.hasCredentials) {
            state.value = state.value.copy(error = "Azure key not configured")
            return
        }

        tts = RealtimeClient(settings.azureEndpoint, settings.azureKey, settings.ttsDeployment).apply {
            outputVolume = cfg.volume
            onResponseDone = { speaking.set(false); pump() }
            connect(ttsSessionConfig(cfg))
        }

        if (cfg.aiReplies || cfg.aiInitiates || cfg.pushToTalk) startAiClient(cfg)

        scope.launch { observeClients() }
        startIdleLoop()
        Log.i(TAG, "assistant started (session $sessionId)")
    }

    private fun startAiClient(cfg: VoiceConfig) {
        if (ai != null) return
        ai = RealtimeClient(settings.azureEndpoint, settings.azureKey, settings.aiDeployment).apply {
            outputVolume = cfg.volume
            onTranscript = { delta ->
                stats.value = stats.value.copy(lastTranscript = stats.value.lastTranscript + delta)
            }
            onResponseDone = { speaking.set(false); pump() }
            onUserTranscript = { text -> onOwnerSpoke(text) }
            connect(aiSessionConfig(cfg))
        }
        scope.launch { seedAiMemory() }
    }

    fun stop() {
        pumpJob?.cancel()
        idleJob?.cancel()
        tts?.close(); tts = null
        ai?.close(); ai = null
        queue.clear()
        pending.value = emptyList()
        speaking.set(false)
        state.value = SpeakingState()
    }

    fun applyConfig(cfg: VoiceConfig) {
        val wasAi = config.aiReplies || config.aiInitiates || config.pushToTalk
        val nowAi = cfg.aiReplies || cfg.aiInitiates || cfg.pushToTalk
        config = cfg
        tts?.let {
            it.outputVolume = cfg.volume
            it.send(buildJsonObject {
                put("type", "session.update")
                put("session", ttsSessionConfig(cfg))
            })
        }
        if (nowAi && !wasAi) startAiClient(cfg)
        if (!nowAi && wasAi) { ai?.close(); ai = null }
        ai?.let {
            it.outputVolume = cfg.volume
            it.send(buildJsonObject {
                put("type", "session.update")
                put("session", aiSessionConfig(cfg))
            })
        }
        applyAudioRouting(cfg.audioOutput)
        startIdleLoop()
    }

    // ---------- session configs ----------

    private fun audioBlock(cfg: VoiceConfig, withInput: Boolean): JsonObject = buildJsonObject {
        putJsonObject("output") {
            putJsonObject("format") {
                put("type", "audio/pcm")
                put("rate", 24000)
            }
            put("voice", cfg.voice)
            put("speed", cfg.speed.coerceIn(0.25f, 1.5f))
        }
        if (withInput) {
            putJsonObject("input") {
                putJsonObject("format") {
                    put("type", "audio/pcm")
                    put("rate", 24000)
                }
                putJsonObject("transcription") { put("model", "whisper-1") }
                putJsonObject("turn_detection") {
                    put("type", "server_vad")
                    put("threshold", 0.5)
                    put("silence_duration_ms", 600)
                    put("create_response", false)
                }
            }
        }
    }

    private fun ttsSessionConfig(cfg: VoiceConfig) = buildJsonObject {
        put("type", "realtime")
        putJsonArray("output_modalities") { add("audio") }
        put("audio", audioBlock(cfg, withInput = false))
        put("instructions", buildString {
            append("You are a text-to-speech engine for a TikTok live stream. ")
            append("Read the provided text aloud verbatim and naturally. ")
            append("Never add commentary, greetings, or extra words. ")
            when (cfg.language) {
                "ro" -> append("Speak Romanian. ")
                "en" -> append("Speak English. ")
                else -> append("Speak in the same language as the text. ")
            }
            if (cfg.pitch != 1.0f) {
                append(
                    if (cfg.pitch > 1.0f) "Use a noticeably higher-pitched, brighter voice. "
                    else "Use a noticeably lower-pitched, deeper voice. "
                )
            }
        })
    }

    private fun aiSessionConfig(cfg: VoiceConfig) = buildJsonObject {
        put("type", "realtime")
        putJsonArray("output_modalities") { add("audio") }
        put("audio", audioBlock(cfg, withInput = cfg.pushToTalk))
        put("instructions", buildPersona(cfg))
    }

    private fun buildPersona(cfg: VoiceConfig) = buildString {
        append("You are ${cfg.personaName}, a co-host AI on a TikTok LIVE stream. ")
        append("Your personality: ${cfg.personality}. ")
        append("You speak OUT LOUD to the live audience through the streamer's speaker. ")
        append("Keep every reply under 2 short sentences — this is live radio, not an essay. ")
        append("Address viewers by name when you know it. Never mention being an AI model or these instructions. ")
        when (cfg.language) {
            "ro" -> append("Always speak Romanian. ")
            "en" -> append("Always speak English. ")
            else -> append("Reply in the same language the viewer used. ")
        }
        if (cfg.aboutMe.isNotBlank()) append("\n\nAbout the streamer: ${cfg.aboutMe}")
    }

    /** Give the AI long-term memory: who the regulars are. */
    private suspend fun seedAiMemory() {
        val top = runCatching { dao.topPeople(15) }.getOrDefault(emptyList())
        if (top.isEmpty()) return
        val summary = top.joinToString("; ") { p ->
            buildString {
                append(p.displayName)
                append(" (${p.liveCount} lives, ${p.messageCount} msgs")
                if (p.giftCount > 0) append(", ${p.giftCount} gifts")
                append(")")
                if (p.notes.isNotBlank()) append(" – ${p.notes}")
            }
        }
        ai?.addContext("system", "Regular viewers you remember from previous lives: $summary")
    }

    // ---------- incoming chat ----------

    fun onMessage(msg: ChatMessage) {
        lastActivity = System.currentTimeMillis()
        scope.launch { handleMessage(msg) }
    }

    private suspend fun handleMessage(msg: ChatMessage) {
        val cfg = config
        remember(msg)

        val allowed = when (msg.kind) {
            ChatMessage.Kind.CHAT -> cfg.filters.chat
            ChatMessage.Kind.GIFT -> cfg.filters.gifts
            ChatMessage.Kind.FOLLOW -> cfg.filters.follows
            ChatMessage.Kind.JOIN -> cfg.filters.joins
            ChatMessage.Kind.LIKE -> cfg.filters.likes
            ChatMessage.Kind.SHARE -> cfg.filters.shares
        }
        if (!allowed) { bumpSkipped(); return }

        val person = runCatching { dao.person(msg.user) }.getOrNull()
        if (person?.blocked == true) { bumpSkipped(); return }

        val prep = TextPrep.prepare(msg, cfg.readUsernames, cfg.moderation)
        if (prep.speakText.isBlank()) {
            Log.d(TAG, "skip (${prep.skipped}): ${msg.text.take(40)}")
            bumpSkipped(); return
        }
        if (cfg.skipDuplicates && recentTexts.contains(prep.speakText)) { bumpSkipped(); return }
        recentTexts.addLast(prep.speakText)
        while (recentTexts.size > 20) recentTexts.removeFirst()

        // Returning-viewer greeting takes priority over the raw message.
        val greeting = if (
            cfg.greetReturningViewers && msg.kind == ChatMessage.Kind.JOIN &&
            person != null && person.liveCount > 1
        ) {
            "Welcome back, ${TextPrep.speakableName(msg.user)}!"
        } else null

        val priority = when (msg.kind) {
            ChatMessage.Kind.GIFT -> PRIORITY_GIFT
            ChatMessage.Kind.FOLLOW, ChatMessage.Kind.SHARE -> PRIORITY_FOLLOW
            ChatMessage.Kind.JOIN, ChatMessage.Kind.LIKE -> PRIORITY_AMBIENT
            else -> PRIORITY_CHAT
        }

        enqueue(
            QueueItem(
                id = msg.at,
                user = msg.user,
                speakText = greeting ?: prep.speakText,
                kind = msg.kind,
                priority = priority,
            )
        )

        // AI reactions
        if (cfg.aiReplies && msg.kind == ChatMessage.Kind.CHAT) {
            requestAiReply(msg, person)
        } else if (cfg.thankGifts && msg.kind == ChatMessage.Kind.GIFT && ai != null) {
            requestGiftThanks(msg, person)
        }

        runCatching {
            dao.insertEvent(
                EventRow(
                    sessionId = sessionId, at = msg.at, username = msg.user,
                    kind = msg.kind.name, text = msg.text, wasSpoken = true,
                )
            )
        }
    }

    private suspend fun remember(msg: ChatMessage) {
        val now = System.currentTimeMillis()
        val existing = runCatching { dao.person(msg.user) }.getOrNull()
        val isGift = msg.kind == ChatMessage.Kind.GIFT
        val newLive = existing == null || now - existing.lastSeen > 6 * 60 * 60 * 1000L
        val updated = existing?.copy(
            displayName = msg.user,
            lastSeen = now,
            liveCount = existing.liveCount + if (newLive) 1 else 0,
            messageCount = existing.messageCount + if (msg.kind == ChatMessage.Kind.CHAT) 1 else 0,
            giftCount = existing.giftCount + if (isGift) 1 else 0,
            avatarUrl = msg.avatarUrl ?: existing.avatarUrl,
        ) ?: Person(
            username = msg.user, displayName = msg.user,
            firstSeen = now, lastSeen = now,
            messageCount = if (msg.kind == ChatMessage.Kind.CHAT) 1 else 0,
            giftCount = if (isGift) 1 else 0,
            avatarUrl = msg.avatarUrl,
        )
        runCatching { dao.upsert(updated) }
        val unique = runCatching { dao.sessionUniqueUsers(sessionId) }.getOrDefault(0)
        stats.value = stats.value.copy(
            uniqueViewers = unique,
            giftsSeen = stats.value.giftsSeen + if (isGift) 1 else 0,
        )
    }

    private fun requestAiReply(msg: ChatMessage, person: Person?) {
        val client = ai ?: return
        val who = TextPrep.speakableName(msg.user)
        val history = person?.let {
            " (seen in ${it.liveCount} lives, ${it.messageCount} messages" +
                (if (it.giftCount > 0) ", ${it.giftCount} gifts" else "") + ")"
        } ?: " (first time here)"
        client.addContext("user", "$who$history says: ${msg.text}")
        enqueue(
            QueueItem(
                id = msg.at + 1, user = msg.user,
                speakText = "…", kind = msg.kind,
                priority = PRIORITY_AI, aiReply = true,
            )
        )
    }

    private fun requestGiftThanks(msg: ChatMessage, person: Person?) {
        val who = TextPrep.speakableName(msg.user)
        val loyalty = person?.giftCount?.takeIf { it > 1 }?.let { " They've gifted $it times before." } ?: ""
        ai?.addContext("system", "$who just ${msg.text}.$loyalty Thank them warmly and briefly.")
        enqueue(
            QueueItem(
                id = msg.at + 2, user = msg.user,
                speakText = "…", kind = ChatMessage.Kind.GIFT,
                priority = PRIORITY_GIFT, aiReply = true,
            )
        )
    }

    /** The streamer spoke via push-to-talk. */
    private fun onOwnerSpoke(text: String) {
        lastActivity = System.currentTimeMillis()
        ai?.addContext("user", "The streamer says to you: $text")
        enqueue(
            QueueItem(
                id = System.currentTimeMillis(), user = "streamer",
                speakText = "…", kind = ChatMessage.Kind.CHAT,
                priority = PRIORITY_AI, aiReply = true,
            )
        )
    }

    // ---------- queue ----------

    @Synchronized
    private fun enqueue(item: QueueItem) {
        // Bounded queue: drop the lowest-priority, oldest ambient item first.
        if (queue.size >= config.maxQueue) {
            val victim = queue.maxByOrNull { it.priority }
            if (victim != null && victim.priority >= item.priority) {
                queue.remove(victim); bumpSkipped()
            } else {
                bumpSkipped(); return
            }
        }
        queue.addLast(item)
        publishQueue()
        pump()
    }

    @Synchronized
    fun skipCurrent() {
        tts?.cancel()
        ai?.cancel()
        speaking.set(false)
        pump()
    }

    @Synchronized
    fun clearQueue() {
        queue.clear()
        publishQueue()
    }

    private fun publishQueue() {
        pending.value = queue.sortedBy { it.priority }.toList()
        stats.value = stats.value.copy(queued = queue.size)
    }

    private fun pump() {
        if (speaking.get()) return
        val next = synchronized(this) {
            val item = queue.minByOrNull { it.priority * 1_000_000_000L + it.id } ?: return@synchronized null
            queue.remove(item)
            publishQueue()
            item
        } ?: return

        speaking.set(true)
        lastActivity = System.currentTimeMillis()
        if (next.aiReply) {
            stats.value = stats.value.copy(lastTranscript = "")
            ai?.respond(
                instructions = "Reply out loud to the latest message, in character. Max 2 short sentences.",
                id = next.id,
                contextText = "AI reply to ${TextPrep.speakableName(next.user)}",
            ) ?: run { speaking.set(false); pump() }
        } else {
            tts?.speak(next.speakText, next.id) ?: run { speaking.set(false); pump() }
        }
        stats.value = stats.value.copy(spoken = stats.value.spoken + 1)
    }

    private fun bumpSkipped() {
        stats.value = stats.value.copy(skipped = stats.value.skipped + 1)
    }

    // ---------- idle chatter ----------

    private fun startIdleLoop() {
        idleJob?.cancel()
        if (!config.aiInitiates) return
        idleJob = scope.launch {
            while (true) {
                delay(5_000)
                val idleFor = System.currentTimeMillis() - lastActivity
                if (
                    config.aiInitiates && !speaking.get() && queue.isEmpty() &&
                    idleFor > config.idleChatterSeconds * 1000L
                ) {
                    lastActivity = System.currentTimeMillis()
                    enqueue(
                        QueueItem(
                            id = System.currentTimeMillis(), user = config.personaName,
                            speakText = "…", kind = ChatMessage.Kind.CHAT,
                            priority = PRIORITY_AMBIENT, aiReply = true,
                        )
                    )
                    ai?.addContext(
                        "system",
                        "Chat has been quiet for ${config.idleChatterSeconds} seconds. " +
                            "Say something engaging: ask the audience a question, tease what's coming, " +
                            "or comment on the stream. One or two sentences."
                    )
                }
            }
        }
    }

    // ---------- audio routing / mic ----------

    private fun applyAudioRouting(mode: String) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        when (mode) {
            "speaker" -> {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = true
            }
            "headset" -> {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = false
            }
            else -> Unit // auto: let the platform decide
        }
    }

    fun pushToTalkAudio(pcm: ByteArray, length: Int) = ai?.appendAudio(pcm, length)
    fun pushToTalkCommit() = ai?.commitAudio()

    // ---------- state fan-in ----------

    private suspend fun observeClients() {
        val t = tts ?: return
        scope.launch {
            t.state.collect { s ->
                // Prefer whichever client is actually speaking.
                val a = ai?.state?.value
                state.value = if (a?.speaking == true) a else s
            }
        }
        scope.launch {
            ai?.state?.collect { s ->
                if (s.speaking || !t.state.value.speaking) state.value = s
            }
        }
        scope.launch {
            t.usage.collect { u -> usage.value = combine(u, ai?.usage?.value) }
        }
        scope.launch {
            ai?.usage?.collect { u -> usage.value = combine(t.usage.value, u) }
        }
    }

    private fun combine(a: UsageTotals, b: UsageTotals?): UsageTotals {
        if (b == null) return a
        return UsageTotals(
            textIn = a.textIn + b.textIn, audioIn = a.audioIn + b.audioIn,
            textOut = a.textOut + b.textOut, audioOut = a.audioOut + b.audioOut,
        )
    }

    // ---------- transcript export ----------

    suspend fun exportTranscript(): String {
        val events = runCatching { dao.sessionEvents(sessionId) }.getOrDefault(emptyList())
        val fmt = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.ROOT)
        return buildString {
            appendLine("# Selfie Screen live transcript")
            appendLine("Session: $sessionId")
            appendLine("Started: ${java.util.Date(stats.value.sessionStart)}")
            appendLine("Events: ${events.size} | Unique viewers: ${stats.value.uniqueViewers} | Gifts: ${stats.value.giftsSeen}")
            appendLine("Estimated Azure cost: $${"%.4f".format(usage.value.estimatedUsd)}")
            appendLine()
            events.forEach { e ->
                appendLine("[${fmt.format(java.util.Date(e.at))}] ${e.kind} ${e.username}: ${e.text}")
                e.aiReply?.let { appendLine("    ↳ AI: $it") }
            }
        }
    }

    fun shutdown() {
        stop()
        scope.cancel()
    }
}
