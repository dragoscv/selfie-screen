package ro.codai.selfiescreen

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.util.Log
import android.util.LruCache
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Tiny async avatar downloader + circular-crop cache for panel rendering.
 * Renderer asks with [get]; misses are fetched in the background and the
 * renderer picks them up on the next frame.
 */
object AvatarCache {

    private const val TAG = "AvatarCache"
    private const val SIZE = 28 // px on panel

    private val cache = LruCache<String, Bitmap>(64)
    private val inflight = ConcurrentHashMap.newKeySet<String>()
    private val executor = Executors.newFixedThreadPool(2)

    /** Returns the circular avatar if cached; else starts a fetch and returns null. */
    fun get(url: String?): Bitmap? {
        if (url.isNullOrBlank()) return null
        cache.get(url)?.let { return it }
        if (inflight.add(url)) {
            executor.execute {
                try {
                    val conn = URL(url).openConnection() as HttpURLConnection
                    conn.connectTimeout = 4000
                    conn.readTimeout = 4000
                    val raw = conn.inputStream.use { BitmapFactory.decodeStream(it) }
                    conn.disconnect()
                    if (raw != null) cache.put(url, circle(raw))
                } catch (e: Exception) {
                    Log.w(TAG, "avatar fetch failed: ${e.message}")
                } finally {
                    inflight.remove(url)
                }
            }
        }
        return null
    }

    private fun circle(src: Bitmap): Bitmap {
        val scaled = Bitmap.createScaledBitmap(src, SIZE, SIZE, true)
        val out = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val path = Path().apply {
            addCircle(SIZE / 2f, SIZE / 2f, SIZE / 2f, Path.Direction.CW)
        }
        canvas.clipPath(path)
        canvas.drawBitmap(scaled, 0f, 0f, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        if (scaled !== src) scaled.recycle()
        return out
    }
}
