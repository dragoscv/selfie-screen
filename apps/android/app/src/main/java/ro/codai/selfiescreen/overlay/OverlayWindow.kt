package ro.codai.selfiescreen.overlay

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DragIndicator
import androidx.compose.material.icons.filled.Opacity
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.ChatAggregator
import ro.codai.selfiescreen.ChatMessage
import ro.codai.selfiescreen.MirrorService
import ro.codai.selfiescreen.TikTokChat
import ro.codai.selfiescreen.voice.SpeakingState
import ro.codai.selfiescreen.voice.VoiceSettings
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val Accent = Color(0xFF62D6FF)
private val AccentWarm = Color(0xFFFFB454)
private val Ok = Color(0xFF4ADE80)
private val Violet = Color(0xFFA78BFA)
private val Red = Color(0xFFF87171)
private val Sky = Color(0xFF38BDF8)
private val TextDim = Color(0xFF8B93A7)

private val timeFmt = SimpleDateFormat("HH:mm", Locale.ROOT)

private fun kindColor(kind: ChatMessage.Kind) = when (kind) {
    ChatMessage.Kind.CHAT -> Accent
    ChatMessage.Kind.GIFT -> AccentWarm
    ChatMessage.Kind.FOLLOW -> Ok
    ChatMessage.Kind.JOIN -> Violet
    ChatMessage.Kind.LIKE -> Red
    ChatMessage.Kind.SHARE -> Sky
}

@Composable
fun OverlayWindow(
    settings: VoiceSettings,
    onDrag: (Float, Float) -> Unit,
    onDragEnd: () -> Unit,
    onResize: (Float, Float) -> Unit,
    onResizeEnd: () -> Unit,
    onBlurChanged: (Float) -> Unit,
    onClose: () -> Unit,
) {
    val cfg by settings.config.collectAsState(initial = ro.codai.selfiescreen.voice.VoiceConfig())
    val messages by TikTokChat.messages.collectAsState()
    val status by TikTokChat.status.collectAsState()
    val scope = rememberCoroutineScope()

    val assistant = MirrorService.assistant
    val speakFlow = remember(assistant) {
        assistant?.state ?: kotlinx.coroutines.flow.MutableStateFlow(SpeakingState())
    }
    val speaking by speakFlow.collectAsState()

    var showControls by remember { mutableStateOf(false) }
    var appeared by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { appeared = true }

    val blurActive by OverlayService.blurActive.collectAsState()
    // With real compositor blur the scrim must get *lighter*, otherwise an
    // opaque panel hides the frost. Without blur support we fall back to a
    // slightly deeper scrim so the slider still does something visible.
    val scrimAlpha = if (blurActive) {
        (cfg.overlayOpacity - cfg.overlayBlur * 0.45f).coerceIn(0.05f, 1f)
    } else {
        (cfg.overlayOpacity + cfg.overlayBlur * 0.18f).coerceAtMost(1f)
    }

    val agg = remember(messages, cfg.collapseJoinsPhone, cfg.collapseLikesPhone, cfg.mergeSameUser) {
        ChatAggregator.aggregate(
            messages,
            collapseJoins = cfg.collapseJoinsPhone,
            collapseLikes = cfg.collapseLikesPhone,
            mergeSameUser = cfg.mergeSameUser,
        )
    }

    val enterScale by animateFloatAsState(
        if (appeared) 1f else 0.9f, tween(320, easing = FastOutSlowInEasing), label = "enter"
    )
    val enterAlpha by animateFloatAsState(
        if (appeared) 1f else 0f, tween(260), label = "alpha"
    )

    MaterialTheme(colorScheme = darkColorScheme(primary = Accent)) {
        Box(
            Modifier
                .fillMaxSize()
                .scale(enterScale)
                .alpha(enterAlpha)
        ) {
            Column(
                Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(20.dp))
                    .background(
                        Brush.verticalGradient(
                            listOf(
                                Color(0xFF0B0E14).copy(alpha = scrimAlpha),
                                Color(0xFF161122).copy(alpha = scrimAlpha),
                            )
                        )
                    )
                    .border(1.dp, Color.White.copy(alpha = 0.09f), RoundedCornerShape(20.dp))
            ) {
                // ---- Drag handle / title bar ----
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(Color.White.copy(alpha = 0.05f))
                        .pointerInput(Unit) {
                            detectDragGestures(
                                onDragEnd = onDragEnd,
                            ) { change, dragAmount ->
                                change.consume()
                                onDrag(dragAmount.x, dragAmount.y)
                            }
                        }
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.DragIndicator, null, tint = TextDim, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    val dot by animateColorAsState(
                        if (status == "live") Ok else TextDim, tween(300), label = "dot"
                    )
                    Box(Modifier.size(6.dp).background(dot, CircleShape))
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "LIVE CHAT", color = Color.White, fontSize = 11.sp,
                        fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp,
                    )
                    Spacer(Modifier.weight(1f))
                    if (speaking.speaking) {
                        SpeakingBars()
                        Spacer(Modifier.width(8.dp))
                    }
                    IconBtn(Icons.Filled.Tune, if (showControls) Accent else TextDim) {
                        showControls = !showControls
                    }
                    Spacer(Modifier.width(4.dp))
                    IconBtn(Icons.Filled.Close, Red, onClose)
                }

                // ---- Controls drawer ----
                AnimatedVisibility(
                    visible = showControls,
                    enter = fadeIn(tween(180)) + expandVertically(tween(220)),
                    exit = fadeOut(tween(120)) + shrinkVertically(tween(160)),
                ) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(Color.Black.copy(alpha = 0.25f))
                            .padding(horizontal = 12.dp, vertical = 8.dp)
                    ) {
                        MiniSlider(
                            "Opacity", cfg.overlayOpacity, 0.15f..1f, Accent,
                        ) { v -> scope.launch { settings.update { it.copy(overlayOpacity = v) } } }
                        MiniSlider(
                            "Blur", cfg.overlayBlur, 0f..1f, Violet,
                        ) { v ->
                            onBlurChanged(v)
                            scope.launch { settings.update { it.copy(overlayBlur = v) } }
                        }
                    }
                }

                // ---- Messages ----
                val listState = rememberLazyListState()

                if (agg.messages.isEmpty()) {
                    Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        LoadingPulse(status)
                    }
                } else {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(
                            horizontal = 10.dp, vertical = 8.dp
                        ),
                        reverseLayout = true,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        items(agg.messages.reversed(), key = { it.at }) { m ->
                            MessageRow(m, isSpeaking = speaking.speaking && speaking.currentId == m.at)
                        }
                    }
                }

                // ---- Collapsed tickers ----
                agg.joinTicker?.let { TickerRow(it.label("joined"), Violet) }
                agg.likeTicker?.let { TickerRow(it.label("liked ❤"), Red) }

                // ---- Resize grip ----
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(22.dp)
                        .background(Color.White.copy(alpha = 0.04f))
                        .pointerInput(Unit) {
                            detectDragGestures(onDragEnd = onResizeEnd) { change, drag ->
                                change.consume()
                                onResize(drag.x, drag.y)
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.OpenInFull, null,
                        tint = TextDim.copy(alpha = 0.7f),
                        modifier = Modifier.size(13.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun MessageRow(m: ChatMessage, isSpeaking: Boolean) {
    val color = kindColor(m.kind)
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(m.at) { shown = true }
    val alpha by animateFloatAsState(if (shown) 1f else 0f, tween(240), label = "row")

    val glow by animateColorAsState(
        if (isSpeaking) color.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.05f),
        tween(220), label = "glow",
    )

    Row(
        Modifier
            .fillMaxWidth()
            .alpha(alpha)
            .background(glow, RoundedCornerShape(10.dp))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .width(3.dp)
                .height(if (isSpeaking) 32.dp else 22.dp)
                .background(color, RoundedCornerShape(2.dp))
        )
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    m.user.take(22), color = color, fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.weight(1f))
                Text(timeFmt.format(Date(m.at)), color = TextDim, fontSize = 9.sp)
            }
            Text(m.text, color = Color(0xFFE4E8F2), fontSize = 12.sp, maxLines = 4)
        }
    }
}

@Composable
private fun TickerRow(text: String, color: Color) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 3.dp)
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(8.dp))
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(5.dp).background(color, CircleShape))
        Spacer(Modifier.width(7.dp))
        Text(text, color = color, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

@Composable
private fun SpeakingBars() {
    val infinite = rememberInfiniteTransition(label = "sp")
    Row(verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { i ->
            val h by infinite.animateFloat(
                4f, 12f,
                infiniteRepeatable(tween(380 + i * 90, easing = FastOutSlowInEasing), RepeatMode.Reverse),
                label = "b$i",
            )
            Box(
                Modifier
                    .padding(horizontal = 1.dp)
                    .width(2.5.dp)
                    .height(h.dp)
                    .background(Ok, RoundedCornerShape(2.dp))
            )
        }
    }
}

@Composable
private fun LoadingPulse(status: String) {
    val infinite = rememberInfiniteTransition(label = "load")
    val scale by infinite.animateFloat(
        0.85f, 1.12f,
        infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "pulse",
    )
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(34.dp)
                .scale(scale)
                .background(Accent.copy(alpha = 0.18f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(9.dp).background(Accent, CircleShape))
        }
        Spacer(Modifier.height(10.dp))
        Text(
            when {
                status == "live" -> "Waiting for messages…"
                status == "connecting" -> "Connecting…"
                status.startsWith("error") -> "Not connected"
                else -> "Offline"
            },
            color = TextDim, fontSize = 11.sp,
        )
    }
}

@Composable
private fun IconBtn(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: Color,
    onClick: () -> Unit,
) {
    var pressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (pressed) 0.85f else 1f, tween(110), label = "btn")
    LaunchedEffect(pressed) { if (pressed) { kotlinx.coroutines.delay(120); pressed = false } }
    Box(
        Modifier
            .size(24.dp)
            .scale(scale)
            .background(Color.White.copy(alpha = 0.07f), CircleShape)
            .clickable { pressed = true; onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(13.dp))
    }
}

@Composable
private fun MiniSlider(
    label: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    color: Color,
    onChange: (Float) -> Unit,
) {
    var local by remember(value) { mutableFloatStateOf(value) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = TextDim, fontSize = 10.sp, modifier = Modifier.width(48.dp))
        Slider(
            value = local,
            onValueChange = { local = it; onChange(it) },
            valueRange = range,
            colors = SliderDefaults.colors(
                thumbColor = color, activeTrackColor = color,
                inactiveTrackColor = Color.White.copy(alpha = 0.12f),
            ),
            modifier = Modifier.weight(1f).height(24.dp),
        )
        Text(
            "${(local * 100).toInt()}%", color = color, fontSize = 10.sp,
            fontWeight = FontWeight.Bold, modifier = Modifier.width(34.dp),
        )
    }
}
