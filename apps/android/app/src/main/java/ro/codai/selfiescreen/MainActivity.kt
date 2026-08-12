package ro.codai.selfiescreen

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.ScreenShare
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Usb
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import ro.codai.selfiescreen.ui.CardBgAlt
import ro.codai.selfiescreen.ui.Violet

private val Bg = Color(0xFF0B0E14)
private val Card = Color(0xFF141926)
private val Accent = Color(0xFF62D6FF)
private val AccentWarm = Color(0xFFFFB454)
private val Ok = Color(0xFF4ADE80)
private val Err = Color(0xFFF87171)
private val TextDim = Color(0xFF8B93A7)

class MainActivity : ComponentActivity() {

    private var pendingMode: MirrorMode? = null

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            if (res.resultCode == RESULT_OK && res.data != null) {
                startMirror(MirrorMode.SCREEN, res.resultCode, res.data)
            }
        }

    private val cameraPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startMirror(MirrorMode.CAMERA)
        }

    private fun requestStart(mode: MirrorMode) {
        val device = UsbScreen.findPanel(this)
        if (device == null) {
            android.widget.Toast.makeText(this, "Panel not detected over USB", android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        if (device != null && !UsbScreen.hasPermission(this, device)) {
            pendingMode = mode
            UsbScreen.requestPermission(this, device) { granted ->
                if (granted) requestStart(pendingMode ?: return@requestPermission)
            }
            return
        }
        when (mode) {
            MirrorMode.SCREEN -> {
                val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                projectionLauncher.launch(mpm.createScreenCaptureIntent())
            }
            MirrorMode.CAMERA -> {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED
                ) startMirror(MirrorMode.CAMERA)
                else cameraPermLauncher.launch(Manifest.permission.CAMERA)
            }
            MirrorMode.CHAT -> startMirror(MirrorMode.CHAT)
        }
    }

    private fun startMirror(mode: MirrorMode, resultCode: Int = 0, data: Intent? = null) {
        val intent = Intent(this, MirrorService::class.java).apply {
            putExtra(MirrorService.EXTRA_MODE, mode.name)
            if (mode == MirrorMode.SCREEN) {
                putExtra(MirrorService.EXTRA_RESULT_CODE, resultCode)
                putExtra(MirrorService.EXTRA_RESULT_DATA, data)
            }
        }
        startForegroundService(intent)
    }

    private fun stopMirror() {
        stopService(Intent(this, MirrorService::class.java))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Seed Azure credentials from the gitignored build config on first run.
        ro.codai.selfiescreen.voice.VoiceSettings(applicationContext).seedIfEmpty(
            BuildConfig.AZURE_ENDPOINT,
            BuildConfig.AZURE_KEY,
            BuildConfig.AZURE_TTS_DEPLOYMENT,
            BuildConfig.AZURE_AI_DEPLOYMENT,
        )
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Accent, background = Bg, surface = Card
                )
            ) {
                AppScreen(
                    onStart = ::requestStart,
                    onStop = ::stopMirror,
                    onRotate = { deg ->
                        // rotate through the running service state
                        MirrorService.state.value.let {
                            // best-effort: rotation is applied by the service
                        }
                        sendRotation(deg)
                    },
                    onBrightness = ::sendBrightness,
                )
            }
        }
    }

    // Simple approach: talk to the service singleton state + a static hook.
    private fun sendRotation(deg: Int) {
        ServiceHooks.rotation?.invoke(deg)
    }

    private fun sendBrightness(level: Int) {
        ServiceHooks.brightness?.invoke(level)
    }
}

/** Lightweight hooks the service registers so the UI can poke it without binding. */
object ServiceHooks {
    var rotation: ((Int) -> Unit)? = null
    var brightness: ((Int) -> Unit)? = null
}

@Composable
fun AppScreen(
    onStart: (MirrorMode) -> Unit,
    onStop: () -> Unit,
    onRotate: (Int) -> Unit,
    onBrightness: (Int) -> Unit,
) {
    val state by MirrorService.state.collectAsState()
    var booted by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { delay(150); booted = true }
    LaunchedEffect(Unit) {
        MirrorService.state.collect { android.util.Log.i("SelfieUI", "ui sees state=$it") }
    }

    Surface(Modifier.fillMaxSize(), color = Bg) {
        Box(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(Modifier.height(24.dp))
            AnimatedVisibility(booted, enter = fadeIn(tween(600)) + slideInVertically { -40 }) {
                Header(state)
            }
            Spacer(Modifier.height(28.dp))

            AnimatedVisibility(booted, enter = fadeIn(tween(700, 150))) {
                StatusRing(state)
            }

            Spacer(Modifier.height(28.dp))

            AnimatedVisibility(booted, enter = fadeIn(tween(700, 300)) + slideInVertically { 60 }) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    if (!state.running) {
                        ModeButton(
                            "Mirror screen", "Duplicate everything to the panel",
                            Icons.Filled.ScreenShare, Accent
                        ) { onStart(MirrorMode.SCREEN) }
                        Spacer(Modifier.height(14.dp))
                        ModeButton(
                            "Rear camera", "Direct camera preview, lowest latency",
                            Icons.Filled.CameraAlt, AccentWarm
                        ) { onStart(MirrorMode.CAMERA) }
                        Spacer(Modifier.height(14.dp))
                        ModeButton(
                            "Chat only", "Just the TikTok chat, nicely rendered",
                            Icons.Filled.Chat, Ok
                        ) { onStart(MirrorMode.CHAT) }
                    } else {
                        RunningControls(state, onStop, onRotate, onBrightness)
                    }
                    Spacer(Modifier.height(18.dp))
                    TikTokCard()
                    Spacer(Modifier.height(14.dp))
                    VoiceStatusCard()
                    state.error?.let {
                        Spacer(Modifier.height(16.dp))
                        Text(it, color = Err, fontSize = 13.sp)
                    }
                }
            }
        }
        val ctxTop = androidx.compose.ui.platform.LocalContext.current
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .padding(top = 28.dp, end = 24.dp)
                .size(40.dp)
                .background(Card, androidx.compose.foundation.shape.CircleShape)
                .clickable {
                    ctxTop.startActivity(Intent(ctxTop, ro.codai.selfiescreen.ui.VoiceSettingsActivity::class.java))
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Settings, null, tint = TextDim, modifier = Modifier.size(20.dp))
        }
        }
    }
}

@Composable
private fun TikTokCard() {
    val status by TikTokChat.status.collectAsState()
    val messages by TikTokChat.messages.collectAsState()
    var username by remember { mutableStateOf("") }
    val live = status == "live"
    val connecting = status == "connecting"
    val ctx0 = androidx.compose.ui.platform.LocalContext.current
    var loggedIn by remember { mutableStateOf(TikTokLoginActivity.isLoggedIn()) }
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(lifecycleOwner) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
                loggedIn = TikTokLoginActivity.isLoggedIn()
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(Card, RoundedCornerShape(20.dp))
            .padding(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Chat, null, tint = if (live) Ok else TextDim, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("TikTok LIVE chat overlay", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(8.dp))
            val statusColor by animateColorAsState(
                when {
                    live -> Ok
                    connecting -> AccentWarm
                    status.startsWith("error") -> Err
                    else -> TextDim
                }, tween(300), label = "st"
            )
            Box(Modifier.size(7.dp).background(statusColor, CircleShape))
        }
        Spacer(Modifier.height(12.dp))
        if (!loggedIn) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(AccentWarm.copy(alpha = 0.12f), RoundedCornerShape(12.dp))
                    .clickable {
                        ctx0.startActivity(
                            Intent(ctx0, TikTokLoginActivity::class.java)
                        )
                    }
                    .padding(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Filled.Chat, null, tint = AccentWarm, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(10.dp))
                Column {
                    Text("Sign in to TikTok", color = AccentWarm, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Required once — chat needs a logged-in web session",
                        color = TextDim, fontSize = 11.sp
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                placeholder = { Text("@username", color = TextDim) },
                singleLine = true,
                enabled = !live && !connecting,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent,
                    unfocusedBorderColor = TextDim.copy(alpha = 0.4f),
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                ),
                modifier = Modifier.weight(1f)
            )
            val ctx = androidx.compose.ui.platform.LocalContext.current
            Spacer(Modifier.width(10.dp))
            Box(
                Modifier
                    .background(if (live) Err.copy(alpha = 0.2f) else Accent.copy(alpha = 0.2f), RoundedCornerShape(12.dp))
                    .clickable(enabled = username.isNotBlank() || live) {
                        if (live || connecting) TikTokChat.disconnect()
                        else TikTokChat.connect(ctx, username.trim())
                    }
                    .padding(horizontal = 16.dp, vertical = 14.dp)
            ) {
                Text(
                    if (live || connecting) "Stop" else "Go",
                    color = if (live || connecting) Err else Accent,
                    fontSize = 13.sp, fontWeight = FontWeight.Bold
                )
            }
        }
        if (status.startsWith("error")) {
            Spacer(Modifier.height(6.dp))
            Text(status.removePrefix("error:"), color = Err, fontSize = 11.sp)
        }
        AnimatedVisibility(messages.isNotEmpty()) {
            Column(Modifier.padding(top = 10.dp)) {
                messages.takeLast(3).forEach { m ->
                    Row {
                        Text(
                            m.user.take(14),
                            color = if (m.kind == ChatMessage.Kind.GIFT) AccentWarm else Accent,
                            fontSize = 12.sp, fontWeight = FontWeight.SemiBold
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(m.text, color = TextDim, fontSize = 12.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun Header(state: MirrorState) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            "SELFIE SCREEN",
            color = Color.White,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 4.sp
        )
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            val dotColor by animateColorAsState(
                if (state.panelConnected) Ok else TextDim, tween(400), label = "dot"
            )
            Box(
                Modifier
                    .size(8.dp)
                    .background(dotColor, CircleShape)
            )
            Spacer(Modifier.width(8.dp))
            Icon(Icons.Filled.Usb, null, tint = TextDim, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(
                if (state.panelConnected) "Turing 3.5\" connected" else "Panel not active",
                color = TextDim, fontSize = 13.sp
            )
        }
    }
}

@Composable
private fun StatusRing(state: MirrorState) {
    val infinite = rememberInfiniteTransition(label = "ring")
    val pulse by infinite.animateFloat(
        1f, if (state.running) 1.06f else 1f,
        infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "pulse"
    )
    val sweep by infinite.animateFloat(
        0f, 360f,
        infiniteRepeatable(tween(2400, easing = LinearEasing)),
        label = "sweep"
    )
    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(190.dp)) {
        androidx.compose.foundation.Canvas(Modifier.fillMaxSize().scale(pulse)) {
            val stroke = 10f
            drawArc(
                color = Card,
                startAngle = 0f, sweepAngle = 360f, useCenter = false,
                style = androidx.compose.ui.graphics.drawscope.Stroke(stroke)
            )
            if (state.running) {
                drawArc(
                    brush = Brush.sweepGradient(listOf(Color.Transparent, Accent)),
                    startAngle = sweep, sweepAngle = 120f, useCenter = false,
                    style = androidx.compose.ui.graphics.drawscope.Stroke(
                        stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round
                    )
                )
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (state.running) {
                Text(
                    "%.1f".format(state.fps),
                    color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Bold
                )
                Text("FPS", color = TextDim, fontSize = 12.sp, letterSpacing = 2.sp)
                Spacer(Modifier.height(4.dp))
                Text("${state.frames} frames", color = TextDim, fontSize = 11.sp)
            } else {
                Text("READY", color = TextDim, fontSize = 18.sp, letterSpacing = 3.sp)
            }
        }
    }
}

@Composable
private fun ModeButton(
    title: String,
    subtitle: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: Color,
    onClick: () -> Unit,
) {
    var pressed by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, tween(120), label = "press")
    Row(
        Modifier
            .fillMaxWidth()
            .scale(scale)
            .background(Card, RoundedCornerShape(20.dp))
            .clickable { pressed = true; onClick() }
            .padding(20.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier
                .size(48.dp)
                .background(tint.copy(alpha = 0.15f), RoundedCornerShape(14.dp)),
            contentAlignment = Alignment.Center
        ) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(24.dp))
        }
        Spacer(Modifier.width(16.dp))
        Column {
            Text(title, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = TextDim, fontSize = 12.sp)
        }
    }
    LaunchedEffect(pressed) { if (pressed) { delay(150); pressed = false } }
}

@Composable
private fun RunningControls(
    state: MirrorState,
    onStop: () -> Unit,
    onRotate: (Int) -> Unit,
    onBrightness: (Int) -> Unit,
) {
    var brightness by remember { mutableFloatStateOf(90f) }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            SmallAction(Icons.Filled.ScreenRotation, "Rotate ${state.rotationDeg}°") {
                onRotate((state.rotationDeg + 90) % 360)
            }
            SmallAction(Icons.Filled.Stop, "Stop", Err) { onStop() }
        }
        Spacer(Modifier.height(20.dp))
        Text("Panel brightness", color = TextDim, fontSize = 12.sp)
        Slider(
            value = brightness,
            onValueChange = { brightness = it },
            onValueChangeFinished = { onBrightness(brightness.toInt()) },
            valueRange = 5f..100f,
            modifier = Modifier.fillMaxWidth()
        )
    }
}

@Composable
private fun SmallAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: Color = Accent,
    onClick: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .background(Card, RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 22.dp, vertical = 14.dp)
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp))
        Spacer(Modifier.height(6.dp))
        Text(label, color = Color.White, fontSize = 12.sp)
    }
}

@Composable
private fun VoiceStatusCard() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val settings = remember { ro.codai.selfiescreen.voice.VoiceSettings(context.applicationContext) }
    val cfg by settings.config.collectAsState(initial = ro.codai.selfiescreen.voice.VoiceConfig())
    if (!cfg.enabled) return

    val assistant = MirrorService.assistant
    val speakFlow = remember(assistant) {
        assistant?.state ?: kotlinx.coroutines.flow.MutableStateFlow(ro.codai.selfiescreen.voice.SpeakingState())
    }
    val statsFlow = remember(assistant) {
        assistant?.stats ?: kotlinx.coroutines.flow.MutableStateFlow(ro.codai.selfiescreen.voice.AssistantStats())
    }
    val speaking by speakFlow.collectAsState()
    val stats by statsFlow.collectAsState()

    var holdingMic by remember { mutableStateOf(false) }
    var mic by remember { mutableStateOf<ro.codai.selfiescreen.voice.MicCapture?>(null) }

    Column(
        Modifier
            .fillMaxWidth()
            .background(Card, RoundedCornerShape(20.dp))
            .padding(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Filled.GraphicEq, null,
                tint = if (speaking.speaking) Ok else TextDim,
                modifier = Modifier.size(18.dp)
            )
            Spacer(Modifier.width(8.dp))
            Text("AI voice", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(8.dp))
            val dotColor by animateColorAsState(
                if (speaking.connected) Ok else if (speaking.error != null) Err else TextDim,
                tween(300), label = "voiceDot"
            )
            Box(Modifier.size(7.dp).background(dotColor, CircleShape))
        }
        Spacer(Modifier.height(10.dp))

        AnimatedVisibility(speaking.speaking) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Ok.copy(alpha = 0.1f), RoundedCornerShape(12.dp))
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MiniWaveform(level = speaking.level)
                Spacer(Modifier.width(10.dp))
                Text(
                    speaking.currentText.ifBlank { "…" }.take(60),
                    color = Ok, fontSize = 12.sp, maxLines = 2,
                    modifier = Modifier.weight(1f)
                )
            }
            Spacer(Modifier.height(10.dp))
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            VoiceStat("Spoken", stats.spoken)
            VoiceStat("Queued", stats.queued)
            VoiceStat("Viewers", stats.uniqueViewers)
            VoiceStat("Gifts", stats.giftsSeen)
        }

        if (cfg.pushToTalk) {
            Spacer(Modifier.height(12.dp))
            val scale by animateFloatAsState(if (holdingMic) 1.08f else 1f, tween(150), label = "mic")
            Box(
                Modifier
                    .fillMaxWidth()
                    .scale(scale)
                    .background(
                        if (holdingMic) Violet.copy(alpha = 0.28f) else CardBgAlt,
                        RoundedCornerShape(14.dp)
                    )
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            val down = awaitFirstDown()
                            holdingMic = true
                            val m = ro.codai.selfiescreen.voice.MicCapture(
                                onChunk = { buf, len -> assistant?.pushToTalkAudio(buf, len) },
                            )
                            mic = m
                            m.start()
                            waitForUpOrCancellation()
                            holdingMic = false
                            mic?.stop()
                            assistant?.pushToTalkCommit()
                            mic = null
                        }
                    }
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Mic, null, tint = if (holdingMic) Violet else TextDim, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (holdingMic) "Listening… release to send" else "Hold to talk to your co-host",
                        color = if (holdingMic) Violet else TextDim, fontSize = 13.sp
                    )
                }
            }
        }

        speaking.error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = Err, fontSize = 11.sp)
        }
    }
}

@Composable
private fun MiniWaveform(level: Float) {
    val infinite = rememberInfiniteTransition(label = "wave")
    Row(verticalAlignment = Alignment.CenterVertically) {
        repeat(4) { i ->
            val phase by infinite.animateFloat(
                0.3f, 1f,
                infiniteRepeatable(tween(400 + i * 80, easing = FastOutSlowInEasing), RepeatMode.Reverse),
                label = "bar$i"
            )
            Box(
                Modifier
                    .padding(horizontal = 1.5.dp)
                    .width(3.dp)
                    .height((8 + 16 * level * phase).dp)
                    .background(Ok, RoundedCornerShape(2.dp))
            )
        }
    }
}

@Composable
private fun VoiceStat(label: String, value: Int) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value.toString(), color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Text(label, color = TextDim, fontSize = 10.sp)
    }
}
