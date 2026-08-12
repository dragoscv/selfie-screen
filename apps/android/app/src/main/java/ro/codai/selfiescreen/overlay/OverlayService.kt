package ro.codai.selfiescreen.overlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import androidx.compose.runtime.CompositionContext
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.lifecycle.lifecycleScope
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.voice.VoiceSettings
import kotlin.math.roundToInt

/**
 * Floating always-on-top chat window. Survives app switching so the streamer
 * can read chat while using TikTok, the camera, or anything else.
 *
 * Uses TYPE_APPLICATION_OVERLAY with a Compose view hosted in a
 * ViewTree*Owner-bridged container (a service has no Activity, so lifecycle,
 * saved-state and viewmodel owners must be supplied manually).
 */
class OverlayService : LifecycleService(), ViewModelStoreOwner, SavedStateRegistryOwner {

    companion object {
        private const val CHANNEL = "overlay"
        const val ACTION_STOP = "ro.codai.selfiescreen.OVERLAY_STOP"

        /** True when the compositor is actually blurring behind the window. */
        val blurActive = kotlinx.coroutines.flow.MutableStateFlow(false)

        fun canDraw(context: Context): Boolean = Settings.canDrawOverlays(context)

        fun start(context: Context) {
            context.startForegroundService(Intent(context, OverlayService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, OverlayService::class.java))
        }
    }

    override val viewModelStore = ViewModelStore()
    private val savedStateController = SavedStateRegistryController.create(this)
    override val savedStateRegistry: SavedStateRegistry
        get() = savedStateController.savedStateRegistry

    private lateinit var windowManager: WindowManager
    private var rootView: View? = null
    private lateinit var params: WindowManager.LayoutParams
    private lateinit var settings: VoiceSettings
    private var lastBlur = 0f
    private var blurListener: java.util.function.Consumer<Boolean>? = null

    override fun onCreate() {
        savedStateController.performRestore(null)
        super.onCreate()
        settings = VoiceSettings(applicationContext)
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        startForegroundNotification()
        lifecycleScope.launch { addOverlay() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.action == ACTION_STOP) stopSelf()
        return START_STICKY
    }

    private fun startForegroundNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Chat overlay", NotificationManager.IMPORTANCE_MIN)
        )
        val stopIntent = android.app.PendingIntent.getService(
            this, 1,
            Intent(this, OverlayService::class.java).setAction(ACTION_STOP),
            android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val notif: Notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Chat overlay active")
            .setContentText("Tap to hide the floating window")
            .addAction(Notification.Action.Builder(null, "Hide", stopIntent).build())
            .setOngoing(true)
            .build()
        startForeground(2, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    }

    private suspend fun addOverlay() {
        val cfg = settings.config.first()
        val density = resources.displayMetrics.density

        params = WindowManager.LayoutParams(
            (cfg.overlayWidth * density).roundToInt(),
            (cfg.overlayHeight * density).roundToInt(),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (cfg.overlayX * density).roundToInt()
            y = (cfg.overlayY * density).roundToInt()
        }

        applyBlur(cfg.overlayBlur)
        registerBlurListener()

        val compose = ComposeView(this).apply {
            setViewTreeLifecycleOwner(this@OverlayService)
            setViewTreeViewModelStoreOwner(this@OverlayService)
            setViewTreeSavedStateRegistryOwner(this@OverlayService)
            setContent {
                OverlayWindow(
                    settings = settings,
                    onDrag = { dx, dy ->
                        params.x += dx.roundToInt()
                        params.y += dy.roundToInt()
                        safeUpdate()
                    },
                    onDragEnd = {
                        lifecycleScope.launch {
                            settings.update {
                                it.copy(
                                    overlayX = (params.x / density).roundToInt(),
                                    overlayY = (params.y / density).roundToInt(),
                                )
                            }
                        }
                    },
                    onResize = { dw, dh ->
                        params.width = (params.width + dw).roundToInt()
                            .coerceIn((200 * density).roundToInt(), (520 * density).roundToInt())
                        params.height = (params.height + dh).roundToInt()
                            .coerceIn((160 * density).roundToInt(), (900 * density).roundToInt())
                        safeUpdate()
                    },
                    onResizeEnd = {
                        lifecycleScope.launch {
                            settings.update {
                                it.copy(
                                    overlayWidth = (params.width / density).roundToInt(),
                                    overlayHeight = (params.height / density).roundToInt(),
                                )
                            }
                        }
                    },
                    onBlurChanged = { blur ->
                        lastBlur = blur
                        applyBlur(blur)
                        safeUpdate()
                    },
                    onClose = { stopSelf() },
                )
            }
        }
        rootView = compose
        runCatching { windowManager.addView(compose, params) }
    }

    private fun safeUpdate() {
        rootView?.let { runCatching { windowManager.updateViewLayout(it, params) } }
    }

    /**
     * Real compositor blur of whatever is *behind* the window bounds
     * (setBackgroundBlurRadius), which is what produces frosted glass.
     * FLAG_BLUR_BEHIND alone blurs the whole screen behind the window and is
     * only a fallback here. Both silently no-op when the system has
     * cross-window blur disabled (battery saver / reduce transparency /
     * low-end device), so we track that and let the UI know.
     */
    private fun applyBlur(blur: Float) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        lastBlur = blur
        val supported = windowManager.isCrossWindowBlurEnabled
        blurActive.value = supported && blur > 0.01f
        val radius = if (supported) (blur * 120f).roundToInt() else 0
        // Blurs whatever is behind the window's bounds. (setBackgroundBlurRadius
        // is a Window API and is unavailable to a service-hosted overlay.)
        params.blurBehindRadius = radius
        params.flags = if (radius > 0) {
            params.flags or WindowManager.LayoutParams.FLAG_BLUR_BEHIND
        } else {
            params.flags and WindowManager.LayoutParams.FLAG_BLUR_BEHIND.inv()
        }
        // No FLAG_DIM_BEHIND: dimming the whole screen behind the overlay is
        // what made the slider look like it only changed a backdrop tint.
        params.dimAmount = 0f
    }

    private fun registerBlurListener() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        if (blurListener != null) return
        blurListener = java.util.function.Consumer<Boolean> {
            applyBlur(lastBlur)
            safeUpdate()
        }.also { windowManager.addCrossWindowBlurEnabledListener(it) }
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            blurListener?.let { runCatching { windowManager.removeCrossWindowBlurEnabledListener(it) } }
        }
        blurListener = null
        rootView?.let { runCatching { windowManager.removeView(it) } }
        rootView = null
        viewModelStore.clear()
        super.onDestroy()
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }
}
