package ro.codai.selfiescreen

import android.util.Log
import java.net.HttpURLConnection
import java.net.URL

/**
 * Polls TikTok's webcast im/fetch endpoint and decodes the protobuf response
 * with a minimal hand-rolled reader (no codegen). Wire structures follow
 * the community-documented Webcast protos (TikTok-Live-Connector et al.):
 *
 * WebcastResponse: 1=messages(repeated Message), 2=cursor(string)
 * Message:         1=method(string), 2=payload(bytes)
 * WebcastChatMessage:   2=user(User), 3=content(string)
 * WebcastGiftMessage:   7=user(User), 15=gift(GiftStruct{16=name})
 * WebcastSocialMessage: 2=user(User)
 * WebcastMemberMessage: 2=user(User)
 * User: 3=nickname(string)
 */
object WebcastPoller {

    private const val TAG = "WebcastPoller"

    @Volatile private var running = false
    private var thread: Thread? = null

    fun start(roomId: String, cookies: String?, onMessage: (ChatMessage) -> Unit, onStatus: (String) -> Unit) {
        stop()
        running = true
        thread = Thread {
            var cursor = ""
            var failures = 0
            onStatus("live")
            while (running) {
                try {
                    val url = URL(
                        "https://webcast.tiktok.com/webcast/im/fetch/?aid=1988&app_language=en" +
                            "&device_platform=web&cursor=$cursor&room_id=$roomId" +
                            "&resp_content_type=protobuf&fetch_rule=1&last_rtt=0&live_id=12" +
                            "&history_comment_count=6"
                    )
                    val conn = url.openConnection() as HttpURLConnection
                    conn.connectTimeout = 5000
                    conn.readTimeout = 8000
                    conn.setRequestProperty(
                        "User-Agent",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                    )
                    conn.setRequestProperty("Referer", "https://www.tiktok.com/")
                    if (!cookies.isNullOrBlank()) conn.setRequestProperty("Cookie", cookies)
                    val code = conn.responseCode
                    if (code != 200) throw IllegalStateException("http $code")
                    val body = conn.inputStream.readBytes()
                    conn.disconnect()
                    failures = 0

                    var msgCount = 0
                    val root = PbReader(body)
                    while (root.hasMore()) {
                        val (field, wire) = root.tag()
                        if (field == 1 && wire == 2) {
                            msgCount++
                            decodeMessage(root.bytes(), onMessage)
                        } else if (field == 2 && wire == 2) {
                            cursor = root.string()
                        } else {
                            root.skip(wire)
                        }
                    }
                    Log.i(TAG, "poll ok: ${body.size}B, $msgCount msgs, cursor=${cursor.take(20)}")
                } catch (e: Exception) {
                    failures++
                    if (failures <= 3 || failures % 10 == 0) Log.w(TAG, "poll fail $failures: ${e.message}")
                    if (failures > 20) {
                        onStatus("error:${e.message}")
                        break
                    }
                }
                try {
                    Thread.sleep(1200)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }.also { it.isDaemon = true; it.start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
    }

    /** Decode one WebcastResponse frame; returns the next cursor ("" if none). */
    fun decodeFrame(body: ByteArray, onMessage: (ChatMessage) -> Unit): String {
        var cursor = ""
        var msgCount = 0
        val root = PbReader(body)
        while (root.hasMore()) {
            val (field, wire) = root.tag()
            when {
                field == 1 && wire == 2 -> { msgCount++; decodeMessage(root.bytes(), onMessage) }
                field == 2 && wire == 2 -> cursor = root.string()
                else -> root.skip(wire)
            }
        }
        Log.i(TAG, "frame: ${body.size}B, $msgCount msgs, cursor=${cursor.take(16)}")
        return cursor
    }

    /**
     * Decode a sniffed frame that may be either a WebcastResponse directly
     * (im/fetch body) or a WebcastPushFrame (WS binary; field 7 = payload,
     * possibly gzipped WebcastResponse).
     */
    fun decodeAny(body: ByteArray, onMessage: (ChatMessage) -> Unit) {
        decodeAnyWithAck(body, onMessage)
    }

    /**
     * Same as [decodeAny] but also returns the WebSocket ACK that must be sent
     * back for this frame. TikTok's webcast server stops pushing after a few
     * unacknowledged frames, which is why chat died after 3-4 messages.
     *
     * PushFrame: 1=seqId, 2=logId, 6=payloadEncoding, 7=payload
     * Ack frame (WebcastWebsocketAck): 1=id(varint), 2=type(string "ack")
     *
     * @return base64 ack bytes to send, or null when no ack is required.
     */
    fun decodeAnyWithAck(body: ByteArray, onMessage: (ChatMessage) -> Unit): ByteArray? {
        var logId = 0L
        var payload: ByteArray? = null
        var isGzip = false

        // Parse as PushFrame first (the WS wire format).
        try {
            val r = PbReader(body)
            while (r.hasMore()) {
                val (f, w) = r.tag()
                when {
                    f == 2 && w == 0 -> logId = r.varint()
                    f == 7 && w == 2 -> payload = r.bytes()
                    else -> r.skip(w)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "pushframe parse failed: ${e.message}")
        }

        if (payload != null) {
            var p = payload
            if (p.size > 2 && p[0] == 0x1f.toByte() && p[1] == 0x8b.toByte()) {
                isGzip = true
                p = runCatching {
                    java.util.zip.GZIPInputStream(p.inputStream()).readBytes()
                }.getOrDefault(p)
            }
            val n = countDecoded(p, onMessage)
            if (n == 0 && !isGzip) countDecoded(body, onMessage)
            return if (logId != 0L) buildAck(logId) else null
        }

        // Try direct WebcastResponse first.
        val direct = countDecoded(body, onMessage)
        if (direct > 0 && logId != 0L) return buildAck(logId)
        return if (logId != 0L) buildAck(logId) else null
    }

    /** WebcastWebsocketAck { 1: id (varint), 2: type = "ack" }. */
    private fun buildAck(logId: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        out.write(0x08) // field 1, varint
        writeVarint(out, logId)
        out.write(0x12) // field 2, length-delimited
        val type = "ack".toByteArray(Charsets.UTF_8)
        out.write(type.size)
        out.write(type)
        return out.toByteArray()
    }

    private fun writeVarint(out: java.io.ByteArrayOutputStream, value: Long) {
        var v = value
        while (true) {
            if (v and 0x7FL.inv() == 0L) {
                out.write(v.toInt())
                return
            }
            out.write(((v and 0x7F) or 0x80).toInt())
            v = v ushr 7
        }
    }

    private fun countDecoded(body: ByteArray, onMessage: (ChatMessage) -> Unit): Int {
        return try {
            var n = 0
            val root = PbReader(body)
            while (root.hasMore()) {
                val (field, wire) = root.tag()
                if (field == 1 && wire == 2) {
                    n++
                    decodeMessage(root.bytes(), onMessage)
                } else root.skip(wire)
            }
            if (n > 0) Log.i(TAG, "decoded $n msgs from ${body.size}B frame")
            n
        } catch (e: Exception) {
            0
        }
    }

    private fun decodeMessage(data: ByteArray, onMessage: (ChatMessage) -> Unit) {
        var method = ""
        var payload = ByteArray(0)
        val r = PbReader(data)
        while (r.hasMore()) {
            val (field, wire) = r.tag()
            when {
                field == 1 && wire == 2 -> method = r.string()
                field == 2 && wire == 2 -> payload = r.bytes()
                else -> r.skip(wire)
            }
        }
        when (method) {
            "WebcastChatMessage" -> {
                var u: UserInfo? = null; var content = ""
                val p = PbReader(payload)
                while (p.hasMore()) {
                    val (f, w) = p.tag()
                    when {
                        f == 2 && w == 2 -> u = readUser(p.bytes())
                        f == 3 && w == 2 -> content = p.string()
                        else -> p.skip(w)
                    }
                }
                if (content.isNotBlank()) {
                    onMessage(ChatMessage(u?.nickname ?: "?", content, ChatMessage.Kind.CHAT, avatarUrl = u?.avatarUrl))
                }
            }
            "WebcastGiftMessage" -> {
                var u: UserInfo? = null; var gift: String? = null; var combo = 0L
                val p = PbReader(payload)
                while (p.hasMore()) {
                    val (f, w) = p.tag()
                    when {
                        f == 5 && w == 0 -> combo = p.varint()
                        f == 7 && w == 2 -> u = readUser(p.bytes())
                        f == 15 && w == 2 -> gift = readGiftName(p.bytes()) ?: gift
                        else -> p.skip(w)
                    }
                }
                val comboTxt = if (combo > 1) " ×$combo" else ""
                onMessage(ChatMessage(u?.nickname ?: "?", "sent ${gift ?: "a gift"}$comboTxt 🎁", ChatMessage.Kind.GIFT, avatarUrl = u?.avatarUrl))
            }
            "WebcastSocialMessage" -> {
                var u: UserInfo? = null; var action = ""
                val p = PbReader(payload)
                while (p.hasMore()) {
                    val (f, w) = p.tag()
                    when {
                        f == 2 && w == 2 -> u = readUser(p.bytes())
                        f == 4 && w == 2 -> action = p.string()
                        else -> p.skip(w)
                    }
                }
                if (u != null) {
                    val isShare = action.contains("share", ignoreCase = true)
                    onMessage(
                        if (isShare) ChatMessage(u.nickname, "shared the LIVE 📣", ChatMessage.Kind.SHARE, avatarUrl = u.avatarUrl)
                        else ChatMessage(u.nickname, "followed ✨", ChatMessage.Kind.FOLLOW, avatarUrl = u.avatarUrl)
                    )
                }
            }
            "WebcastMemberMessage" -> {
                val u = readUserField(payload, 2)
                if (u != null) onMessage(ChatMessage(u.nickname, "joined", ChatMessage.Kind.JOIN, avatarUrl = u.avatarUrl))
            }
            "WebcastLikeMessage" -> {
                var u: UserInfo? = null; var count = 0L
                val p = PbReader(payload)
                while (p.hasMore()) {
                    val (f, w) = p.tag()
                    when {
                        f == 2 && w == 0 -> count = p.varint()
                        f == 5 && w == 2 -> u = readUser(p.bytes())
                        else -> p.skip(w)
                    }
                }
                if (u != null) {
                    val n = if (count > 1) " ×$count" else ""
                    onMessage(ChatMessage(u.nickname, "liked$n ❤", ChatMessage.Kind.LIKE, avatarUrl = u.avatarUrl))
                }
            }
        }
    }

    data class UserInfo(val nickname: String, val avatarUrl: String?)

    private fun readUserField(payload: ByteArray, userField: Int): UserInfo? {
        val p = PbReader(payload)
        while (p.hasMore()) {
            val (f, w) = p.tag()
            if (f == userField && w == 2) return readUser(p.bytes())
            p.skip(w)
        }
        return null
    }

    /** User: 3=nickname, 9=avatarThumb(Image{1=urls repeated}). */
    private fun readUser(user: ByteArray): UserInfo {
        var nickname = "?"
        var avatar: String? = null
        val r = PbReader(user)
        while (r.hasMore()) {
            val (f, w) = r.tag()
            when {
                f == 3 && w == 2 -> nickname = r.string()
                f == 9 && w == 2 -> avatar = readImageUrl(r.bytes()) ?: avatar
                else -> r.skip(w)
            }
        }
        return UserInfo(nickname, avatar)
    }

    private fun readImageUrl(image: ByteArray): String? {
        val r = PbReader(image)
        while (r.hasMore()) {
            val (f, w) = r.tag()
            if (f == 1 && w == 2) {
                val url = r.string()
                if (url.startsWith("http")) return url
            } else r.skip(w)
        }
        return null
    }

    private fun readGiftName(gift: ByteArray): String? {
        val r = PbReader(gift)
        while (r.hasMore()) {
            val (f, w) = r.tag()
            if (f == 16 && w == 2) return r.string()
            r.skip(w)
        }
        return null
    }

    /** Tiny protobuf wire-format reader. */
    private class PbReader(private val buf: ByteArray) {
        private var pos = 0
        fun hasMore() = pos < buf.size

        fun varint(): Long {
            var shift = 0
            var result = 0L
            while (pos < buf.size) {
                val b = buf[pos++].toInt()
                result = result or ((b and 0x7F).toLong() shl shift)
                if (b and 0x80 == 0) return result
                shift += 7
                if (shift > 63) break
            }
            return result
        }

        fun tag(): Pair<Int, Int> {
            val v = varint()
            return Pair((v ushr 3).toInt(), (v and 7).toInt())
        }

        fun bytes(): ByteArray {
            val len = varint().toInt().coerceIn(0, buf.size - pos)
            val out = buf.copyOfRange(pos, pos + len)
            pos += len
            return out
        }

        fun string() = bytes().toString(Charsets.UTF_8)

        fun skip(wire: Int) {
            when (wire) {
                0 -> varint()
                1 -> pos = (pos + 8).coerceAtMost(buf.size)
                2 -> { val len = varint().toInt().coerceIn(0, buf.size - pos); pos += len }
                5 -> pos = (pos + 4).coerceAtMost(buf.size)
                else -> pos = buf.size
            }
        }
    }
}
