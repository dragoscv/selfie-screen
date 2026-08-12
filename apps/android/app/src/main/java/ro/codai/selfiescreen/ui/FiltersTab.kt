package ro.codai.selfiescreen.ui

import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Shield
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.voice.VoiceConfig
import ro.codai.selfiescreen.voice.VoiceSettings

fun LazyListScope.filterTabItems(cfg: VoiceConfig, settings: VoiceSettings, scope: CoroutineScope) {
    item {
        SettingsCard("What gets read aloud", icon = Icons.Filled.Chat) {
            SwitchRow("Chat messages", checked = cfg.filters.chat) { v ->
                scope.launch { settings.update { it.copy(filters = it.filters.copy(chat = v)) } }
            }
            SwitchRow("Gifts", checked = cfg.filters.gifts) { v ->
                scope.launch { settings.update { it.copy(filters = it.filters.copy(gifts = v)) } }
            }
            SwitchRow("Follows", checked = cfg.filters.follows) { v ->
                scope.launch { settings.update { it.copy(filters = it.filters.copy(follows = v)) } }
            }
            SwitchRow("Shares", checked = cfg.filters.shares) { v ->
                scope.launch { settings.update { it.copy(filters = it.filters.copy(shares = v)) } }
            }
            SwitchRow("Joins", "Off by default \u2014 can get noisy", checked = cfg.filters.joins) { v ->
                scope.launch { settings.update { it.copy(filters = it.filters.copy(joins = v)) } }
            }
            SwitchRow("Likes", "Off by default \u2014 very frequent", checked = cfg.filters.likes) { v ->
                scope.launch { settings.update { it.copy(filters = it.filters.copy(likes = v)) } }
            }
        }
    }
    item {
        SettingsCard("Speaking style", icon = Icons.Filled.CardGiftcard, accent = AccentWarm) {
            SwitchRow(
                "Announce usernames",
                "\"Alex says: hello\" vs just \"hello\"",
                checked = cfg.readUsernames, accent = AccentWarm,
            ) { v -> scope.launch { settings.update { it.copy(readUsernames = v) } } }
            SwitchRow(
                "Auto-thank gifts",
                "AI reacts to gifts by name, mentions loyalty",
                checked = cfg.thankGifts, accent = AccentWarm,
            ) { v -> scope.launch { settings.update { it.copy(thankGifts = v) } } }
            SwitchRow(
                "Greet returning viewers",
                "Special welcome when a known viewer rejoins",
                checked = cfg.greetReturningViewers, accent = AccentWarm,
            ) { v -> scope.launch { settings.update { it.copy(greetReturningViewers = v) } } }
            SwitchRow(
                "Skip duplicate messages",
                "Avoid repeating spammy identical texts",
                checked = cfg.skipDuplicates, accent = AccentWarm,
            ) { v -> scope.launch { settings.update { it.copy(skipDuplicates = v) } } }
        }
    }
    item {
        SettingsCard("Safety & flow", icon = Icons.Filled.Shield, accent = Err) {
            SwitchRow(
                "Moderation filter",
                "Skip profanity/slurs automatically",
                checked = cfg.moderation, accent = Err,
            ) { v -> scope.launch { settings.update { it.copy(moderation = v) } } }
            SliderRow(
                "Max speech queue", cfg.maxQueue.toFloat(), 3f..20f, accent = Err,
                format = { "${it.toInt()} msgs" }, steps = 16,
            ) { v -> scope.launch { settings.update { it.copy(maxQueue = v.toInt()) } } }
        }
    }
}
