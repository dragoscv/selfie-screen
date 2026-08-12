package ro.codai.selfiescreen.ui

import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Text
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.voice.VoiceConfig
import ro.codai.selfiescreen.voice.VoiceSettings

fun LazyListScope.assistantTabItems(cfg: VoiceConfig, settings: VoiceSettings, scope: CoroutineScope) {
    item {
        SettingsCard(
            "AI co-host", "Uses gpt-realtime-2.1 with full live context",
            icon = Icons.Filled.AutoAwesome, accent = Violet,
        ) {
            SwitchRow(
                "AI replies to chat",
                "Responds out loud to viewer messages, in character",
                checked = cfg.aiReplies, accent = Violet,
            ) { v -> scope.launch { settings.update { it.copy(aiReplies = v) } } }
            SwitchRow(
                "AI initiates conversation",
                "Speaks up when chat goes quiet \u2014 asks questions, proposes topics",
                checked = cfg.aiInitiates, accent = Violet,
            ) { v -> scope.launch { settings.update { it.copy(aiInitiates = v) } } }
            Reveal(cfg.aiInitiates) {
                SliderRow(
                    "Idle chatter after", cfg.idleChatterSeconds.toFloat(), 30f..600f, accent = Violet,
                    format = { "${(it / 60).toInt()}m ${(it % 60).toInt()}s" }, steps = 18,
                ) { v -> scope.launch { settings.update { it.copy(idleChatterSeconds = v.toInt()) } } }
            }
            SwitchRow(
                "Push-to-talk with AI",
                "Hold the mic button to talk to your co-host live",
                checked = cfg.pushToTalk, accent = Violet,
            ) { v -> scope.launch { settings.update { it.copy(pushToTalk = v) } } }
        }
    }
    item {
        SettingsCard("Persona", icon = Icons.Filled.Forum, accent = Ok) {
            TextInput("Assistant name", cfg.personaName, "Aria") { v ->
                scope.launch { settings.update { it.copy(personaName = v) } }
            }
            TextInput(
                "Personality", cfg.personality, "friendly, witty, concise",
            ) { v -> scope.launch { settings.update { it.copy(personality = v) } } }
            TextInput(
                "About you", cfg.aboutMe, "e.g. I'm a Kotlin dev streaming from Romania…",
                singleLine = false,
            ) { v -> scope.launch { settings.update { it.copy(aboutMe = v) } } }
        }
    }
    item {
        SettingsCard("Voice input", icon = Icons.Filled.Mic, accent = AccentWarm) {
            Text(
                "When push-to-talk is on, hold the mic button on the main screen to speak " +
                    "to your AI co-host \u2014 it hears you and replies out loud through the panel speaker.",
                color = TextDim, fontSize = 12.sp,
            )
        }
    }
}
