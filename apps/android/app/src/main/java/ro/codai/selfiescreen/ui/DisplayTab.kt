package ro.codai.selfiescreen.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.PictureInPicture
import androidx.compose.material.icons.filled.ViewAgenda
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.overlay.OverlayService
import ro.codai.selfiescreen.voice.VoiceConfig
import ro.codai.selfiescreen.voice.VoiceSettings

fun LazyListScope.displayTabItems(cfg: VoiceConfig, settings: VoiceSettings, scope: CoroutineScope) {
    item {
        SettingsCard(
            "Collapse repetitive events",
            "Joins and likes become one summary row instead of flooding the feed",
            icon = Icons.Filled.ViewAgenda, accent = Violet,
        ) {
            Text("Side panel", color = TextMid, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            SwitchRow(
                "Collapse joins", "One \"Ana, Mihai +6 joined\" ticker row",
                checked = cfg.collapseJoinsPanel, accent = Violet,
            ) { v -> scope.launch { settings.update { it.copy(collapseJoinsPanel = v) } } }
            SwitchRow(
                "Collapse likes", checked = cfg.collapseLikesPanel, accent = Violet,
            ) { v -> scope.launch { settings.update { it.copy(collapseLikesPanel = v) } } }

            Spacer(Modifier.height(6.dp))
            Text("Phone & overlay", color = TextMid, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            SwitchRow(
                "Collapse joins", "Off keeps the full join history on the phone",
                checked = cfg.collapseJoinsPhone, accent = Accent,
            ) { v -> scope.launch { settings.update { it.copy(collapseJoinsPhone = v) } } }
            SwitchRow(
                "Collapse likes", checked = cfg.collapseLikesPhone, accent = Accent,
            ) { v -> scope.launch { settings.update { it.copy(collapseLikesPhone = v) } } }

            Spacer(Modifier.height(6.dp))
            SwitchRow(
                "Merge same user", "Fold a viewer's rapid messages into one row",
                checked = cfg.mergeSameUser, accent = Ok,
            ) { v -> scope.launch { settings.update { it.copy(mergeSameUser = v) } } }
        }
    }
    item { OverlayCard(cfg, settings, scope) }
}

@Composable
private fun OverlayCard(cfg: VoiceConfig, settings: VoiceSettings, scope: CoroutineScope) {
    val context = LocalContext.current
    var canDraw by remember { mutableStateOf(OverlayService.canDraw(context)) }
    val owner = LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) canDraw = OverlayService.canDraw(context)
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    SettingsCard(
        "Floating chat window",
        "Read chat while using TikTok or any other app",
        icon = Icons.Filled.PictureInPicture, accent = Accent,
    ) {
        if (!canDraw) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(AccentWarm.copy(alpha = 0.12f), RoundedCornerShape(12.dp))
                    .clickable {
                        context.startActivity(
                            Intent(
                                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                Uri.parse("package:${context.packageName}"),
                            )
                        )
                    }
                    .padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Layers, null, tint = AccentWarm, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(
                        "Grant \"Draw over other apps\"", color = AccentWarm,
                        fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    )
                    Text("Required once — tap to open settings", color = TextDim, fontSize = 11.sp)
                }
            }
        } else {
            SwitchRow(
                "Show floating window",
                "Drag the title bar to move, bottom grip to resize",
                checked = cfg.overlayEnabled, accent = Accent,
            ) { v ->
                scope.launch { settings.update { it.copy(overlayEnabled = v) } }
                if (v) OverlayService.start(context) else OverlayService.stop(context)
            }
            Reveal(cfg.overlayEnabled) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SliderRow(
                        "Background opacity", cfg.overlayOpacity, 0.15f..1f, accent = Accent,
                        format = { "${(it * 100).toInt()}%" },
                    ) { v -> scope.launch { settings.update { it.copy(overlayOpacity = v) } } }
                    SliderRow(
                        "Background blur", cfg.overlayBlur, 0f..1f, accent = Violet,
                        format = { if (it < 0.02f) "Off" else "${(it * 100).toInt()}%" },
                    ) { v -> scope.launch { settings.update { it.copy(overlayBlur = v) } } }
                    Text(
                        "Opacity and blur can also be tuned live from the window's own control drawer.",
                        color = TextDim, fontSize = 11.sp,
                    )
                }
            }
        }
    }
}
