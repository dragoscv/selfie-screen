package ro.codai.selfiescreen.voice

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** Which event kinds get read aloud. */
data class ReadFilters(
    val chat: Boolean = true,
    val gifts: Boolean = true,
    val follows: Boolean = true,
    val joins: Boolean = false,
    val likes: Boolean = false,
    val shares: Boolean = true,
)

data class VoiceConfig(
    val enabled: Boolean = true,
    val voice: String = "marin",
    val speed: Float = 1.0f,
    val pitch: Float = 1.0f,
    val volume: Float = 1.0f,
    val filters: ReadFilters = ReadFilters(),
    val minGiftValueToRead: Int = 0,
    val readUsernames: Boolean = true,
    val language: String = "auto", // auto | ro | en
    val audioOutput: String = "auto", // auto | speaker | headset
    // AI assistant
    val aiReplies: Boolean = false,
    val aiInitiates: Boolean = false,
    val idleChatterSeconds: Int = 120,
    val pushToTalk: Boolean = false,
    val personaName: String = "Aria",
    val aboutMe: String = "",
    val personality: String = "friendly, witty, concise",
    // Safety / throughput
    val moderation: Boolean = true,
    val maxQueue: Int = 8,
    val skipDuplicates: Boolean = true,
    val greetReturningViewers: Boolean = true,
    val thankGifts: Boolean = true,
    // Display aggregation
    /** Collapse joins into a single ticker row on the panel. */
    val collapseJoinsPanel: Boolean = true,
    /** Collapse joins into a single ticker row on the phone too. */
    val collapseJoinsPhone: Boolean = false,
    /** Same, for likes. */
    val collapseLikesPanel: Boolean = true,
    val collapseLikesPhone: Boolean = false,
    /** Merge consecutive messages from the same user into one row. */
    val mergeSameUser: Boolean = true,
    // Floating overlay window
    val overlayEnabled: Boolean = false,
    val overlayOpacity: Float = 0.82f,
    val overlayBlur: Float = 0.35f,
    val overlayX: Int = 24,
    val overlayY: Int = 200,
    val overlayWidth: Int = 340,
    val overlayHeight: Int = 420,
    val overlayClickThrough: Boolean = false,
) {
    companion object {
        /** gpt-realtime voices (2026-07). */
        val VOICES = listOf(
            "marin", "cedar", "alloy", "ash", "ballad",
            "coral", "echo", "sage", "shimmer", "verse",
        )
    }
}

private val Context.voiceStore by preferencesDataStore("voice_settings")

/**
 * Persisted voice/assistant configuration. The Azure key lives in
 * EncryptedSharedPreferences (hardware-backed keystore), never in DataStore.
 */
class VoiceSettings(private val context: Context) {

    private object K {
        val enabled = booleanPreferencesKey("enabled")
        val voice = stringPreferencesKey("voice")
        val speed = floatPreferencesKey("speed")
        val pitch = floatPreferencesKey("pitch")
        val volume = floatPreferencesKey("volume")
        val fChat = booleanPreferencesKey("f_chat")
        val fGifts = booleanPreferencesKey("f_gifts")
        val fFollows = booleanPreferencesKey("f_follows")
        val fJoins = booleanPreferencesKey("f_joins")
        val fLikes = booleanPreferencesKey("f_likes")
        val fShares = booleanPreferencesKey("f_shares")
        val minGift = intPreferencesKey("min_gift")
        val readUsernames = booleanPreferencesKey("read_usernames")
        val language = stringPreferencesKey("language")
        val audioOutput = stringPreferencesKey("audio_output")
        val aiReplies = booleanPreferencesKey("ai_replies")
        val aiInitiates = booleanPreferencesKey("ai_initiates")
        val idleChatter = intPreferencesKey("idle_chatter")
        val pushToTalk = booleanPreferencesKey("push_to_talk")
        val personaName = stringPreferencesKey("persona_name")
        val aboutMe = stringPreferencesKey("about_me")
        val personality = stringPreferencesKey("personality")
        val moderation = booleanPreferencesKey("moderation")
        val maxQueue = intPreferencesKey("max_queue")
        val skipDuplicates = booleanPreferencesKey("skip_duplicates")
        val greetReturning = booleanPreferencesKey("greet_returning")
        val thankGifts = booleanPreferencesKey("thank_gifts")
        val collapseJoinsPanel = booleanPreferencesKey("collapse_joins_panel")
        val collapseJoinsPhone = booleanPreferencesKey("collapse_joins_phone")
        val collapseLikesPanel = booleanPreferencesKey("collapse_likes_panel")
        val collapseLikesPhone = booleanPreferencesKey("collapse_likes_phone")
        val mergeSameUser = booleanPreferencesKey("merge_same_user")
        val overlayEnabled = booleanPreferencesKey("overlay_enabled")
        val overlayOpacity = floatPreferencesKey("overlay_opacity")
        val overlayBlur = floatPreferencesKey("overlay_blur")
        val overlayX = intPreferencesKey("overlay_x")
        val overlayY = intPreferencesKey("overlay_y")
        val overlayWidth = intPreferencesKey("overlay_w")
        val overlayHeight = intPreferencesKey("overlay_h")
        val overlayClickThrough = booleanPreferencesKey("overlay_click_through")
    }

    val config: Flow<VoiceConfig> = context.voiceStore.data.map { p -> p.toConfig() }

    private fun Preferences.toConfig(): VoiceConfig {
        val d = VoiceConfig()
        return VoiceConfig(
            enabled = this[K.enabled] ?: d.enabled,
            voice = this[K.voice] ?: d.voice,
            speed = this[K.speed] ?: d.speed,
            pitch = this[K.pitch] ?: d.pitch,
            volume = this[K.volume] ?: d.volume,
            filters = ReadFilters(
                chat = this[K.fChat] ?: d.filters.chat,
                gifts = this[K.fGifts] ?: d.filters.gifts,
                follows = this[K.fFollows] ?: d.filters.follows,
                joins = this[K.fJoins] ?: d.filters.joins,
                likes = this[K.fLikes] ?: d.filters.likes,
                shares = this[K.fShares] ?: d.filters.shares,
            ),
            minGiftValueToRead = this[K.minGift] ?: d.minGiftValueToRead,
            readUsernames = this[K.readUsernames] ?: d.readUsernames,
            language = this[K.language] ?: d.language,
            audioOutput = this[K.audioOutput] ?: d.audioOutput,
            aiReplies = this[K.aiReplies] ?: d.aiReplies,
            aiInitiates = this[K.aiInitiates] ?: d.aiInitiates,
            idleChatterSeconds = this[K.idleChatter] ?: d.idleChatterSeconds,
            pushToTalk = this[K.pushToTalk] ?: d.pushToTalk,
            personaName = this[K.personaName] ?: d.personaName,
            aboutMe = this[K.aboutMe] ?: d.aboutMe,
            personality = this[K.personality] ?: d.personality,
            moderation = this[K.moderation] ?: d.moderation,
            maxQueue = this[K.maxQueue] ?: d.maxQueue,
            skipDuplicates = this[K.skipDuplicates] ?: d.skipDuplicates,
            greetReturningViewers = this[K.greetReturning] ?: d.greetReturningViewers,
            thankGifts = this[K.thankGifts] ?: d.thankGifts,
            collapseJoinsPanel = this[K.collapseJoinsPanel] ?: d.collapseJoinsPanel,
            collapseJoinsPhone = this[K.collapseJoinsPhone] ?: d.collapseJoinsPhone,
            collapseLikesPanel = this[K.collapseLikesPanel] ?: d.collapseLikesPanel,
            collapseLikesPhone = this[K.collapseLikesPhone] ?: d.collapseLikesPhone,
            mergeSameUser = this[K.mergeSameUser] ?: d.mergeSameUser,
            overlayEnabled = this[K.overlayEnabled] ?: d.overlayEnabled,
            overlayOpacity = this[K.overlayOpacity] ?: d.overlayOpacity,
            overlayBlur = this[K.overlayBlur] ?: d.overlayBlur,
            overlayX = this[K.overlayX] ?: d.overlayX,
            overlayY = this[K.overlayY] ?: d.overlayY,
            overlayWidth = this[K.overlayWidth] ?: d.overlayWidth,
            overlayHeight = this[K.overlayHeight] ?: d.overlayHeight,
            overlayClickThrough = this[K.overlayClickThrough] ?: d.overlayClickThrough,
        )
    }

    suspend fun update(block: (VoiceConfig) -> VoiceConfig) {
        context.voiceStore.edit { p ->
            val next = block(p.toConfig())
            p[K.enabled] = next.enabled
            p[K.voice] = next.voice
            p[K.speed] = next.speed
            p[K.pitch] = next.pitch
            p[K.volume] = next.volume
            p[K.fChat] = next.filters.chat
            p[K.fGifts] = next.filters.gifts
            p[K.fFollows] = next.filters.follows
            p[K.fJoins] = next.filters.joins
            p[K.fLikes] = next.filters.likes
            p[K.fShares] = next.filters.shares
            p[K.minGift] = next.minGiftValueToRead
            p[K.readUsernames] = next.readUsernames
            p[K.language] = next.language
            p[K.audioOutput] = next.audioOutput
            p[K.aiReplies] = next.aiReplies
            p[K.aiInitiates] = next.aiInitiates
            p[K.idleChatter] = next.idleChatterSeconds
            p[K.pushToTalk] = next.pushToTalk
            p[K.personaName] = next.personaName
            p[K.aboutMe] = next.aboutMe
            p[K.personality] = next.personality
            p[K.moderation] = next.moderation
            p[K.maxQueue] = next.maxQueue
            p[K.skipDuplicates] = next.skipDuplicates
            p[K.greetReturning] = next.greetReturningViewers
            p[K.thankGifts] = next.thankGifts
            p[K.collapseJoinsPanel] = next.collapseJoinsPanel
            p[K.collapseJoinsPhone] = next.collapseJoinsPhone
            p[K.collapseLikesPanel] = next.collapseLikesPanel
            p[K.collapseLikesPhone] = next.collapseLikesPhone
            p[K.mergeSameUser] = next.mergeSameUser
            p[K.overlayEnabled] = next.overlayEnabled
            p[K.overlayOpacity] = next.overlayOpacity
            p[K.overlayBlur] = next.overlayBlur
            p[K.overlayX] = next.overlayX
            p[K.overlayY] = next.overlayY
            p[K.overlayWidth] = next.overlayWidth
            p[K.overlayHeight] = next.overlayHeight
            p[K.overlayClickThrough] = next.overlayClickThrough
        }
    }

    // ---- Azure credentials (encrypted, hardware-backed) ----

    private val secure by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context, "azure_secrets", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var azureEndpoint: String
        get() = secure.getString("endpoint", DEFAULT_ENDPOINT) ?: DEFAULT_ENDPOINT
        set(v) = secure.edit().putString("endpoint", v).apply()

    var azureKey: String
        get() = secure.getString("key", "") ?: ""
        set(v) = secure.edit().putString("key", v).apply()

    var ttsDeployment: String
        get() = secure.getString("tts_deployment", "selfie-tts") ?: "selfie-tts"
        set(v) = secure.edit().putString("tts_deployment", v).apply()

    var aiDeployment: String
        get() = secure.getString("ai_deployment", "selfie-ai") ?: "selfie-ai"
        set(v) = secure.edit().putString("ai_deployment", v).apply()

    val hasCredentials: Boolean get() = azureKey.isNotBlank() && azureEndpoint.isNotBlank()

    /**
     * Seeds credentials from a build-time default the first time the app runs,
     * so the 84-char Azure key never has to be typed on a phone keyboard.
     * A user-entered value always wins afterwards.
     */
    fun seedIfEmpty(endpoint: String, key: String, tts: String, ai: String) {
        if (azureKey.isBlank() && key.isNotBlank()) {
            azureEndpoint = endpoint
            azureKey = key
            ttsDeployment = tts
            aiDeployment = ai
        }
    }

    companion object {
        const val DEFAULT_ENDPOINT = "codai-foundry2.openai.azure.com"
    }
}
