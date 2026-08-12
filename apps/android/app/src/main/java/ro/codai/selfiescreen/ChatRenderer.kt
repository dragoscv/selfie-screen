package ro.codai.selfiescreen

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import ro.codai.selfiescreen.voice.SpeakingState

/**
 * Renders the chat-only layout for the panel (320x480 portrait):
 * gradient background, header with LIVE status + 24h clock, and message
 * rows with circular avatars, per-event accent colors, and timestamps.
 */
object ChatRenderer {

    private const val W = TuringLcd.WIDTH
    private const val H = TuringLcd.HEIGHT

    private const val HEADER_H = 84f
    private const val AVATAR = 28f
    private const val PAD = 12f

    private val bitmap = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)

    private val bgPaint = Paint().apply {
        shader = LinearGradient(
            0f, 0f, 0f, H.toFloat(),
            intArrayOf(Color.rgb(11, 14, 20), Color.rgb(22, 17, 34), Color.rgb(11, 14, 20)),
            null, Shader.TileMode.CLAMP
        )
    }
    private val headerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textSize = 20f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        letterSpacing = 0.16f
    }
    private val clockPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(180, 188, 205); textSize = 17f
        typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        textAlign = Paint.Align.RIGHT
    }
    private val liveDot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val livePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 11f; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        letterSpacing = 0.18f
    }
    private val namePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 14f; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    private val msgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(228, 232, 242); textSize = 14f
    }
    private val timePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(110, 118, 138); textSize = 11f
        typeface = Typeface.MONOSPACE
        textAlign = Paint.Align.RIGHT
    }
    private val emptyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(139, 147, 167); textSize = 15f
        textAlign = Paint.Align.CENTER
    }
    private val bubblePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val avatarBgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val avatarInitialPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textSize = 14f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textAlign = Paint.Align.CENTER
    }
    private val dividerPaint = Paint().apply { color = Color.argb(50, 255, 255, 255) }
    private val speakingGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val waveBarPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(74, 222, 128) }
    private val speakingLabelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(74, 222, 128); textSize = 10f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        letterSpacing = 0.12f
    }

    // Minute resolution on purpose: a ticking seconds field repainted the
    // header every second, which combined with new messages at the bottom
    // dirtied the whole panel and collapsed the refresh rate.
    private val clockFmt = SimpleDateFormat("HH:mm", Locale.ROOT)
    private val msgTimeFmt = SimpleDateFormat("HH:mm", Locale.ROOT)

    private fun kindColor(kind: ChatMessage.Kind): Int = when (kind) {
        ChatMessage.Kind.CHAT -> Color.rgb(98, 214, 255)
        ChatMessage.Kind.GIFT -> Color.rgb(255, 180, 84)
        ChatMessage.Kind.FOLLOW -> Color.rgb(74, 222, 128)
        ChatMessage.Kind.JOIN -> Color.rgb(167, 139, 250)
        ChatMessage.Kind.LIKE -> Color.rgb(248, 113, 113)
        ChatMessage.Kind.SHARE -> Color.rgb(56, 189, 248)
    }

    private val tickerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 12f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    private val tickerBgPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    /** Compact single-line summary row pinned to the bottom; returns new bottom Y. */
    private fun drawTicker(canvas: Canvas, text: String, color: Int, bottom: Float): Float {
        val h = 22f
        val top = bottom - h
        tickerBgPaint.color = color
        tickerBgPaint.alpha = 34
        canvas.drawRoundRect(RectF(PAD - 4f, top, W - PAD + 4f, bottom), 10f, 10f, tickerBgPaint)
        tickerBgPaint.alpha = 255
        canvas.drawCircle(PAD + 5f, top + h / 2, 3f, tickerBgPaint)
        tickerPaint.color = color
        var t = text
        val maxW = W - PAD * 2 - 20f
        if (tickerPaint.measureText(t) > maxW) {
            while (t.isNotEmpty() && tickerPaint.measureText("$t…") > maxW) t = t.dropLast(1)
            t = "$t…"
        }
        canvas.drawText(t, PAD + 14f, top + h / 2 + 4.5f, tickerPaint)
        return top - 4f
    }

    private fun wrap(text: String, paint: Paint, maxWidth: Float, maxLines: Int): List<String> {
        val words = text.split(" ")
        val lines = mutableListOf<String>()
        var line = StringBuilder()
        for (w in words) {
            val candidate = if (line.isEmpty()) w else "$line $w"
            if (paint.measureText(candidate) <= maxWidth) {
                line = StringBuilder(candidate)
            } else {
                if (line.isNotEmpty()) lines.add(line.toString())
                line = StringBuilder(w)
                if (lines.size == maxLines - 1) break
            }
        }
        if (line.isNotEmpty() && lines.size < maxLines) lines.add(line.toString())
        if (lines.size == maxLines && words.joinToString(" ") != lines.joinToString(" ")) {
            lines[maxLines - 1] = lines[maxLines - 1].dropLast(1) + "…"
        }
        return lines
    }

    @Synchronized
    fun render(
        messages: List<ChatMessage>,
        status: String,
        speaking: SpeakingState = SpeakingState(),
        queued: Int = 0,
        joinTicker: ChatAggregator.Ticker? = null,
        likeTicker: ChatAggregator.Ticker? = null,
    ): Bitmap {
        canvas.drawRect(0f, 0f, W.toFloat(), H.toFloat(), bgPaint)

        // ---- Header ----
        canvas.drawText("TIKTOK LIVE", PAD, 34f, headerPaint)
        canvas.drawText(clockFmt.format(Date()), W - PAD, 34f, clockPaint)

        val live = status == "live"
        liveDot.color = when {
            live -> Color.rgb(74, 222, 128)
            status == "connecting" -> Color.rgb(255, 180, 84)
            else -> Color.rgb(120, 120, 130)
        }
        canvas.drawCircle(PAD + 5f, 58f, 5f, liveDot)
        livePaint.color = liveDot.color
        canvas.drawText(
            when {
                live -> "LIVE"
                status == "connecting" -> "CONNECTING…"
                status.startsWith("error") -> "ERROR"
                else -> "OFFLINE"
            }, PAD + 18f, 62f, livePaint
        )
        canvas.drawRect(PAD, HEADER_H - 8f, W - PAD, HEADER_H - 7f, dividerPaint)

        // ---- Speaking indicator: live waveform + queue depth ----
        if (speaking.speaking) {
            val bars = 14
            val bw = 3f
            val gap = 2f
            val baseX = W - PAD - (bars * (bw + gap))
            for (i in 0 until bars) {
                // Pseudo-spectrum: level modulated by bar position for motion.
                val phase = (System.currentTimeMillis() / 90 + i * 3) % 12
                val jitter = 0.45f + 0.55f * (1f - kotlin.math.abs(phase - 6f) / 6f)
                val h = (4f + speaking.level * 26f * jitter).coerceIn(3f, 26f)
                waveBarPaint.alpha = (110 + 145 * jitter).toInt().coerceIn(0, 255)
                canvas.drawRoundRect(
                    RectF(baseX + i * (bw + gap), 62f - h / 2, baseX + i * (bw + gap) + bw, 62f + h / 2),
                    1.5f, 1.5f, waveBarPaint
                )
            }
            canvas.drawText("SPEAKING", PAD + 46f, 62f, speakingLabelPaint)
        } else if (queued > 0) {
            canvas.drawText("QUEUE $queued", PAD + 46f, 62f, speakingLabelPaint)
        }

        // ---- Collapsed ticker rows pinned to the bottom ----
        var bottom = H - 8f
        if (likeTicker != null) {
            bottom = drawTicker(canvas, likeTicker.label("liked ❤"), kindColor(ChatMessage.Kind.LIKE), bottom)
        }
        if (joinTicker != null) {
            bottom = drawTicker(canvas, joinTicker.label("joined"), kindColor(ChatMessage.Kind.JOIN), bottom)
        }

        if (messages.isEmpty()) {
            canvas.drawText("Waiting for messages…", W / 2f, H / 2f, emptyPaint)
            return bitmap
        }

        // ---- Messages: newest at the bottom, drawn bottom-up ----
        val textX = PAD + AVATAR + 10f
        val timeW = timePaint.measureText("00:00") + 6f
        val maxTextW = W - textX - PAD - 8f
        var y = bottom - 2f

        for (m in messages.reversed()) {
            val lines = wrap(m.text, msgPaint, maxTextW, 3)
            val rowH = maxOf(26f + lines.size * 18f, AVATAR + 16f)
            val top = y - rowH
            if (top < HEADER_H) break

            val isSpeaking = speaking.speaking && speaking.currentId == m.at

            // Row background + accent rail (glow while this message is voiced)
            if (isSpeaking) {
                val pulse = 0.65f + 0.35f * kotlin.math.sin(System.currentTimeMillis() / 160.0).toFloat()
                speakingGlowPaint.color = kindColor(m.kind)
                speakingGlowPaint.alpha = (70 * pulse).toInt().coerceIn(20, 110)
                canvas.drawRoundRect(
                    RectF(PAD - 8f, top - 3f, W - PAD + 8f, y - 1f), 14f, 14f, speakingGlowPaint
                )
                bubblePaint.color = Color.argb(80, 255, 255, 255)
            } else {
                bubblePaint.color = Color.argb(38, 255, 255, 255)
            }
            canvas.drawRoundRect(RectF(PAD - 4f, top, W - PAD + 4f, y - 4f), 12f, 12f, bubblePaint)
            bubblePaint.color = kindColor(m.kind)
            val railW = if (isSpeaking) 5f else 3f
            canvas.drawRoundRect(RectF(PAD - 4f, top, PAD - 4f + railW, y - 4f), 2f, 2f, bubblePaint)

            // Avatar (image if cached, else colored initial disc)
            val ax = PAD + 4f
            val ay = top + 8f
            val avatar = AvatarCache.get(m.avatarUrl)
            if (avatar != null) {
                canvas.drawBitmap(avatar, ax, ay, null)
            } else {
                avatarBgPaint.color = kindColor(m.kind)
                avatarBgPaint.alpha = 70
                canvas.drawCircle(ax + AVATAR / 2f, ay + AVATAR / 2f, AVATAR / 2f, avatarBgPaint)
                val initial = m.user.firstOrNull()?.uppercaseChar() ?: '?'
                canvas.drawText(initial.toString(), ax + AVATAR / 2f, ay + AVATAR / 2f + 5f, avatarInitialPaint)
            }

            // Name + timestamp
            namePaint.color = kindColor(m.kind)
            var name = m.user
            val maxNameW = maxTextW - timeW
            if (namePaint.measureText(name) > maxNameW) {
                while (name.isNotEmpty() && namePaint.measureText("$name…") > maxNameW) name = name.dropLast(1)
                name = "$name…"
            }
            canvas.drawText(name, textX, top + 20f, namePaint)
            canvas.drawText(msgTimeFmt.format(Date(m.at)), W - PAD - 2f, top + 20f, timePaint)

            // Message lines
            var ty = top + 38f
            for (line in lines) {
                canvas.drawText(line, textX, ty, msgPaint)
                ty += 18f
            }
            y = top - 6f
        }
        return bitmap
    }
}
