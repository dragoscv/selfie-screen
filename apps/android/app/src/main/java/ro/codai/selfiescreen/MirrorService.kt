package ro.codai.selfiescreen

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Shader
import android.graphics.Typeface
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.voice.VoiceAssistant
import ro.codai.selfiescreen.voice.VoiceSettings
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

enum class MirrorMode { SCREEN, CAMERA, CHAT }

data class MirrorState(
    val running: Boolean = false,
    val mode: MirrorMode = MirrorMode.SCREEN,
    val panelConnected: Boolean = false,
    val fps: Float = 0f,
    val frames: Long = 0,
    val rotationDeg: Int = 0,
    val error: String? = null,
)

class MirrorService : LifecycleService() {

    companion object {
        const val EXTRA_MODE = "mode"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        private const val TAG = "MirrorService"
        private const val CHANNEL = "mirror"

        val state = MutableStateFlow(MirrorState())

        /** Set while the service runs so the UI can drive the assistant. */
        @Volatile var assistant: VoiceAssistant? = null
    }

    inner class LocalBinder : Binder() {
        val service get() = this@MirrorService
    }

    private val binder = LocalBinder()

    private var lcd: TuringLcd? = null
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var cameraProvider: ProcessCameraProvider? = null

    private lateinit var captureThread: HandlerThread
    private lateinit var captureHandler: Handler
    private val pushExecutor = Executors.newSingleThreadExecutor()
    private val pushBusy = AtomicBoolean(false)
    private val latestFrame = AtomicReference<Bitmap?>(null)
    private val lastComposedSrc = AtomicReference<Bitmap?>(null)

    private var rotationDeg = 0
    private var frameCount = 0L
    private var fpsWindowStart = 0L
    private var fpsWindowFrames = 0

    override fun onBind(intent: Intent): IBinder {
        super.onBind(intent)
        return binder
    }

    override fun onCreate() {
        super.onCreate()
        captureThread = HandlerThread("capture").also { it.start() }
        captureHandler = Handler(captureThread.looper)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent == null) return START_NOT_STICKY
        val mode = MirrorMode.valueOf(intent.getStringExtra(EXTRA_MODE) ?: MirrorMode.SCREEN.name)

        if (lcd != null) {
            Log.i(TAG, "already running (${state.value.mode}); ignoring duplicate start")
            return START_STICKY
        }

        startForegroundWithType(mode)

        // Open the panel first.
        try {
            var device = UsbScreen.findPanel(this)
            var attempts = 0
            while (device == null && attempts < 10) {
                Thread.sleep(150)
                device = UsbScreen.findPanel(this)
                attempts++
            }
            if (device == null) throw IllegalStateException("Panel not connected via USB")
            Log.i(TAG, "found panel, hasPermission=${UsbScreen.hasPermission(this, device)}")
            Log.i(TAG, "opening panel ${device.deviceName} vid=${device.vendorId} pid=${device.productId}")
            lcd = UsbScreen.open(this, device)
            Log.i(TAG, "panel opened OK")
        } catch (e: Exception) {
            Log.e(TAG, "panel open failed", e)
            state.value = MirrorState(error = "Panel: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }

        fpsWindowStart = System.currentTimeMillis()
        state.value = MirrorState(running = true, mode = mode, panelConnected = true, rotationDeg = rotationDeg)
        ServiceHooks.rotation = ::setRotation
        ServiceHooks.brightness = ::setBrightness

        // Re-render when chat messages change even if the captured screen is static
        // (MediaProjection only emits frames when pixels change).
        lifecycleScope.launch {
            TikTokChat.messages.collect {
                lastComposedSrc.get()?.let { src -> offerFrame(src) }
            }
        }

        // Voice assistant: feed every new chat message to the speech pipeline.
        startVoiceAssistant()

        when (mode) {
            MirrorMode.SCREEN -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                val resultData: Intent? =
                    if (Build.VERSION.SDK_INT >= 33)
                        intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                    else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_RESULT_DATA)
                if (resultCode != Activity.RESULT_OK || resultData == null) {
                    fail("MediaProjection permission missing")
                    return START_NOT_STICKY
                }
                startScreenCapture(resultCode, resultData)
            }
            MirrorMode.CAMERA -> startCameraCapture()
            MirrorMode.CHAT -> startChatOnly()
        }
        return START_STICKY
    }

    fun setRotation(deg: Int) {
        rotationDeg = ((deg % 360) + 360) % 360
        state.value = state.value.copy(rotationDeg = rotationDeg)
        Log.i(TAG, "setRotation -> $rotationDeg")
        // The whole frame changes on rotation, so the dirty-band diff must be
        // reset, and a fresh frame pushed immediately (a static screen would
        // otherwise emit no new capture and the panel would keep the old image).
        pushExecutor.execute { runCatching { lcd?.invalidateCache() } }
        if (state.value.mode == MirrorMode.CHAT) {
            offerFrame(renderChatFrame())
        } else {
            lastComposedSrc.get()?.let { offerFrame(it) }
        }
    }

    fun setBrightness(level: Int) {
        Log.i(TAG, "setBrightness($level) lcd=${lcd != null}")
        pushExecutor.execute {
            val r = runCatching { lcd?.setBrightness(level) }
            Log.i(TAG, "setBrightness($level) ok=${r.isSuccess} err=${r.exceptionOrNull()?.message}")
        }
    }

    private fun startForegroundWithType(mode: MirrorMode) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Mirroring", NotificationManager.IMPORTANCE_LOW)
        )
        val notif: Notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Selfie Screen")
            .setContentText(if (mode == MirrorMode.SCREEN) "Mirroring screen to panel" else "Camera preview on panel")
            .setOngoing(true)
            .build()
        val type = when (mode) {
            MirrorMode.SCREEN -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            MirrorMode.CAMERA -> ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            MirrorMode.CHAT -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        startForeground(1, notif, type)
    }

    // ---------- Chat-only mode ----------

    private var chatTicker: Thread? = null
    private var lastFedMessageAt = 0L
    /** Latest display config, refreshed by the settings collector. */
    @Volatile private var displayCfg: ro.codai.selfiescreen.voice.VoiceConfig =
        ro.codai.selfiescreen.voice.VoiceConfig()

    /** Render the chat panel with the configured aggregation applied. */
    private fun renderChatFrame(): Bitmap {
        val agg = ChatAggregator.aggregate(
            TikTokChat.messages.value,
            collapseJoins = displayCfg.collapseJoinsPanel,
            collapseLikes = displayCfg.collapseLikesPanel,
            mergeSameUser = displayCfg.mergeSameUser,
        )
        val va = assistant
        return ChatRenderer.render(
            agg.messages,
            TikTokChat.status.value,
            va?.state?.value ?: ro.codai.selfiescreen.voice.SpeakingState(),
            va?.stats?.value?.queued ?: 0,
            agg.joinTicker,
            agg.likeTicker,
        )
    }

    private fun startVoiceAssistant() {
        val settings = VoiceSettings(applicationContext)
        val va = VoiceAssistant(applicationContext, settings)
        assistant = va
        Log.i(TAG, "startVoiceAssistant: created, creds=${settings.hasCredentials}")
        lifecycleScope.launch {
            val cfg = settings.config.first()
            Log.i(TAG, "startVoiceAssistant: first cfg loaded, enabled=${cfg.enabled}")
            if (cfg.enabled) va.start(cfg)
        }
        // Keep the assistant's live config in sync with settings changes.
        lifecycleScope.launch {
            settings.config.collect { cfg ->
                displayCfg = cfg
                if (cfg.enabled && !va.isRunning) va.start(cfg)
                else if (!cfg.enabled && va.isRunning) va.stop()
                else if (va.isRunning) va.applyConfig(cfg)
            }
        }
        // Forward new TikTok messages (dedup via monotonically increasing `at`).
        lifecycleScope.launch {
            TikTokChat.messages.collect { list ->
                list.filter { it.at > lastFedMessageAt }
                    .sortedBy { it.at }
                    .forEach { msg ->
                        lastFedMessageAt = msg.at
                        va.onMessage(msg)
                    }
            }
        }
        // Re-render the chat/overlay whenever the speaking state changes, so the
        // now-playing highlight + waveform update smoothly (~15 fps while active).
        lifecycleScope.launch {
            va.state.collect {
                if (state.value.mode == MirrorMode.CHAT) {
                    offerFrame(renderChatFrame())
                } else {
                    lastComposedSrc.get()?.let { src -> offerFrame(src) }
                }
            }
        }
    }

    private fun startChatOnly() {
        val t = Thread {
            var lastKey = ""
            while (!Thread.currentThread().isInterrupted) {
                val msgs = TikTokChat.messages.value
                val st = TikTokChat.status.value
                val va = assistant
                val speak = va?.state?.value ?: ro.codai.selfiescreen.voice.SpeakingState()
                // While speaking, refresh fast so the waveform animates; otherwise 1 Hz for the clock.
                val tick = if (speak.speaking) System.currentTimeMillis() / 120 else System.currentTimeMillis() / 1000
                val key = "$st|${msgs.joinToString { it.at.toString() }}|$tick|${speak.currentId}|$rotationDeg"
                if (key != lastKey) {
                    lastKey = key
                    offerFrame(renderChatFrame())
                }
                try { Thread.sleep(if (speak.speaking) 80 else 250) } catch (_: InterruptedException) { break }
            }
        }
        chatTicker = t
        t.isDaemon = true
        t.start()
    }

    // ---------- Screen mirror (MediaProjection) ----------

    private fun startScreenCapture(resultCode: Int, data: Intent) {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val proj = mpm.getMediaProjection(resultCode, data)
        projection = proj
        proj.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() = stopSelf()
        }, captureHandler)

        // Capture at 2x panel resolution for decent downscale quality.
        val capW = TuringLcd.WIDTH * 2
        val capH = TuringLcd.HEIGHT * 2
        val reader = ImageReader.newInstance(capW, capH, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        reader.setOnImageAvailableListener({ r ->
            val img = r.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val plane = img.planes[0]
                val rowStride = plane.rowStride
                val pixelStride = plane.pixelStride
                val w = img.width
                val h = img.height
                val bmp = Bitmap.createBitmap(rowStride / pixelStride, h, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(plane.buffer)
                val cropped = if (bmp.width != w) Bitmap.createBitmap(bmp, 0, 0, w, h) else bmp
                offerFrame(cropped)
            } finally {
                img.close()
            }
        }, captureHandler)

        virtualDisplay = proj.createVirtualDisplay(
            "selfie-screen", capW, capH, resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface, null, captureHandler
        )
    }

    // ---------- Camera capture (CameraX ImageAnalysis) ----------

    private fun startCameraCapture() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                cameraProvider = provider
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .build()
                analysis.setAnalyzer(pushExecutor) { proxy -> analyzeCameraFrame(proxy) }
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, analysis)
            } catch (e: Exception) {
                fail("Camera: ${e.message}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun analyzeCameraFrame(proxy: ImageProxy) {
        try {
            val plane = proxy.planes[0]
            val rowStride = plane.rowStride
            val pixelStride = plane.pixelStride
            val bmp = Bitmap.createBitmap(rowStride / pixelStride, proxy.height, Bitmap.Config.ARGB_8888)
            bmp.copyPixelsFromBuffer(plane.buffer)
            val cropped = if (bmp.width != proxy.width)
                Bitmap.createBitmap(bmp, 0, 0, proxy.width, proxy.height) else bmp
            val rotation = proxy.imageInfo.rotationDegrees
            val rotated = if (rotation != 0) {
                val m = Matrix().apply { postRotate(rotation.toFloat()) }
                Bitmap.createBitmap(cropped, 0, 0, cropped.width, cropped.height, m, true)
            } else cropped
            pushToPanel(rotated) // already on pushExecutor thread
        } catch (e: Exception) {
            Log.w(TAG, "camera frame failed", e)
        } finally {
            proxy.close()
        }
    }

    // ---------- Frame pipeline ----------

    /** Keep only the latest frame; drop while a serial push is in flight. */
    private fun offerFrame(src: Bitmap) {
        lastComposedSrc.set(src)
        latestFrame.set(src)
        if (pushBusy.compareAndSet(false, true)) {
            pushExecutor.execute {
                try {
                    var frame = latestFrame.getAndSet(null)
                    while (frame != null) {
                        pushToPanelLocked(frame)
                        frame = latestFrame.getAndSet(null)
                    }
                } finally {
                    pushBusy.set(false)
                }
            }
        }
    }

    private fun pushToPanel(src: Bitmap) = pushToPanelLocked(src)

    private fun pushToPanelLocked(src: Bitmap) {
        val panel = lcd ?: return
        try {
            val frame = composeFrame(src)
            panel.display(frame)
            frameCount++
            fpsWindowFrames++
            val now = System.currentTimeMillis()
            if (now - fpsWindowStart >= 1000) {
                val fps = fpsWindowFrames * 1000f / (now - fpsWindowStart)
                fpsWindowStart = now
                fpsWindowFrames = 0
                state.value = state.value.copy(fps = fps, frames = frameCount)
                Log.i(TAG, "fps=$fps frames=$frameCount running=${state.value.running}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "panel write failed", e)
            fail("Panel write: ${e.message}")
        }
    }

    private val panelBitmap =
        Bitmap.createBitmap(TuringLcd.WIDTH, TuringLcd.HEIGHT, Bitmap.Config.ARGB_8888)
    private val panelCanvas = Canvas(panelBitmap)

    // ---------- TikTok chat overlay ----------

    private val overlayBgPaint = Paint().apply { color = Color.argb(150, 0, 0, 0) }
    private val userPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(98, 214, 255); textSize = 15f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    private val giftPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(255, 180, 84); textSize = 15f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textSize = 15f
    }

    private fun drawChatOverlay(canvas: Canvas) {
        val msgs = TikTokChat.messages.value
        if (msgs.isEmpty()) return
        val lineH = 22f
        val pad = 8f
        val boxH = msgs.size * lineH + pad * 2
        val top = TuringLcd.HEIGHT - boxH
        canvas.drawRect(0f, top, TuringLcd.WIDTH.toFloat(), TuringLcd.HEIGHT.toFloat(), overlayBgPaint)
        var y = top + pad + 15f
        for (m in msgs) {
            val namePaint = if (m.kind == ChatMessage.Kind.GIFT) giftPaint else userPaint
            val name = m.user.take(14)
            canvas.drawText(name, pad, y, namePaint)
            val nameW = namePaint.measureText(name)
            val maxTextW = TuringLcd.WIDTH - pad * 2 - nameW - 6f
            var text = m.text
            if (textPaint.measureText(text) > maxTextW) {
                while (text.isNotEmpty() && textPaint.measureText("$text…") > maxTextW) {
                    text = text.dropLast(1)
                }
                text = "$text…"
            }
            canvas.drawText(text, pad + nameW + 6f, y, textPaint)
            y += lineH
        }
    }

    /** Letterbox + rotate the source into the fixed 320x480 portrait panel frame. */
    private fun composeFrame(src: Bitmap): Bitmap {
        panelCanvas.drawColor(Color.BLACK)
        val rot = rotationDeg

        // Chat frames are rendered at exact panel size. At 0/180 they map 1:1;
        // at 90/270 they must be scaled to fit the swapped aspect.
        if (state.value.mode == MirrorMode.CHAT) {
            if (rot == 0) {
                panelCanvas.drawBitmap(src, 0f, 0f, null)
            } else {
                val m = Matrix()
                m.postTranslate(-src.width / 2f, -src.height / 2f)
                m.postRotate(rot.toFloat())
                if (rot % 180 != 0) {
                    // Rotated 90/270: source is 320x480 laid sideways (480x320),
                    // so scale down to fit the 320-wide panel.
                    val s = minOf(
                        TuringLcd.WIDTH.toFloat() / src.height,
                        TuringLcd.HEIGHT.toFloat() / src.width,
                    )
                    m.postScale(s, s)
                }
                m.postTranslate(TuringLcd.WIDTH / 2f, TuringLcd.HEIGHT / 2f)
                panelCanvas.drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG))
            }
            return panelBitmap
        }

        val srcW = if (rot % 180 == 0) src.width else src.height
        val srcH = if (rot % 180 == 0) src.height else src.width
        val scale = minOf(
            TuringLcd.WIDTH.toFloat() / srcW,
            TuringLcd.HEIGHT.toFloat() / srcH
        )
        val m = Matrix()
        m.postTranslate(-src.width / 2f, -src.height / 2f)
        m.postRotate(rot.toFloat())
        m.postScale(scale, scale)
        m.postTranslate(TuringLcd.WIDTH / 2f, TuringLcd.HEIGHT / 2f)
        panelCanvas.drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG))
        drawChatOverlay(panelCanvas)
        return panelBitmap
    }

    private fun fail(message: String) {
        state.value = state.value.copy(running = false, error = message)
        stopSelf()
    }

    override fun onDestroy() {
        ServiceHooks.rotation = null
        ServiceHooks.brightness = null
        Log.i(TAG, "onDestroy")
        chatTicker?.interrupt()
        assistant?.shutdown()
        assistant = null
        virtualDisplay?.release()
        imageReader?.close()
        projection?.stop()
        cameraProvider?.unbindAll()
        pushExecutor.execute {
            runCatching { lcd?.screenOff() }
            runCatching { lcd?.close() }
            lcd = null
        }
        pushExecutor.shutdown()
        captureThread.quitSafely()
        // Preserve a failure message so the UI can show it after the service dies.
        state.value = MirrorState(error = state.value.error)
        super.onDestroy()
    }
}
