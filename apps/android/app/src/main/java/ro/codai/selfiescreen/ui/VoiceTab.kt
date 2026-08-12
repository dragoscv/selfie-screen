package ro.codai.selfiescreen.ui

import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Speaker
import androidx.compose.material.icons.filled.Tune
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.voice.VoiceConfig
import ro.codai.selfiescreen.voice.VoiceSettings

fun LazyListScope.voiceTabItems(cfg: VoiceConfig, settings: VoiceSettings, scope: CoroutineScope) {
    item {
        SettingsCard("Voice engine", "Azure AI Foundry \u2014 gpt-realtime", icon = Icons.Filled.RecordVoiceOver) {
            SwitchRow(
                "Read messages aloud",
                "Master switch for the whole voice pipeline",
                checked = cfg.enabled,
            ) { v -> scope.launch { settings.update { it.copy(enabled = v) } } }
        }
    }
    item {
        SettingsCard("Voice character", icon = Icons.Filled.Tune, accent = AccentWarm) {
            ChipSelector(
                "Voice", VoiceConfig.VOICES, cfg.voice, accent = AccentWarm,
                display = { it.replaceFirstChar(Char::uppercase) },
            ) { v -> scope.launch { settings.update { it.copy(voice = v) } } }
            SliderRow(
                "Speed", cfg.speed, 0.5f..1.5f, accent = AccentWarm,
                format = { "%.2fx".format(it) },
            ) { v -> scope.launch { settings.update { it.copy(speed = v) } } }
            SliderRow(
                "Pitch", cfg.pitch, 0.6f..1.4f, accent = AccentWarm,
                format = { if (it < 0.95f) "Lower" else if (it > 1.05f) "Higher" else "Natural" },
            ) { v -> scope.launch { settings.update { it.copy(pitch = v) } } }
            SliderRow(
                "Volume", cfg.volume, 0f..1f, accent = AccentWarm,
                format = { "${(it * 100).toInt()}%" },
            ) { v -> scope.launch { settings.update { it.copy(volume = v) } } }
        }
    }
    item {
        SettingsCard("Output & language", icon = Icons.Filled.Speaker, accent = Violet) {
            ChipSelector(
                "Audio output",
                listOf("auto", "speaker", "headset"),
                cfg.audioOutput,
                accent = Violet,
                display = { it.replaceFirstChar(Char::uppercase) },
            ) { v -> scope.launch { settings.update { it.copy(audioOutput = v) } } }
            ChipSelector(
                "Language",
                listOf("auto", "ro", "en"),
                cfg.language,
                accent = Violet,
                display = { if (it == "auto") "Auto-detect" else it.uppercase() },
            ) { v -> scope.launch { settings.update { it.copy(language = v) } } }
        }
    }
    item {
        SettingsCard("Azure credentials", "Stored encrypted on-device", icon = Icons.Filled.Key, accent = Err) {
            TextInput(
                "Endpoint", settings.azureEndpoint, "yourresource.openai.azure.com",
            ) { settings.azureEndpoint = it }
            TextInput(
                "API key", settings.azureKey, "paste your Azure key", isSecret = true,
            ) { settings.azureKey = it }
            TextInput(
                "TTS deployment", settings.ttsDeployment, "selfie-tts",
            ) { settings.ttsDeployment = it }
            TextInput(
                "AI deployment", settings.aiDeployment, "selfie-ai",
            ) { settings.aiDeployment = it }
        }
    }
}
