package ro.codai.selfiescreen

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

data class ChatMessage(
    val user: String,
    val text: String,
    val kind: Kind = Kind.CHAT,
    val at: Long = System.currentTimeMillis(),
    val avatarUrl: String? = null,
) {
    enum class Kind { CHAT, GIFT, FOLLOW, JOIN, LIKE, SHARE }
}

/**
 * Receives TikTok LIVE chat by loading the live page in a hidden WebView and
 * observing the chat DOM with an injected MutationObserver. Runs fully
 * on-device; no third-party relay and no JVM-only APIs (TikTokLiveJava
 * crashed on Android: java.net.http doesn't exist here).
 */
object TikTokChat {

    private const val TAG = "TikTokChat"
    private const val MAX_MESSAGES = 12

    val messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val status = MutableStateFlow("offline") // offline | connecting | live | error:<msg>

    private val buffer = CopyOnWriteArrayList<ChatMessage>()
    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null

        /** Injected at document start: sniffs the page's own webcast WebSocket + fetch. */
        private const val SNIFFER_JS = """
(function() {
    if (window.__ssSniff) return;
    window.__ssSniff = true;
    function b64(buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(bin);
    }
    function unb64(s) {
        var bin = atob(s);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    var OrigWS = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
        try {
            SS.onDebug('ws open: ' + String(url).slice(0, 90));
            var n = 0;
            var acked = 0;
            ws.binaryType = 'arraybuffer';
            function handle(ab) {
                // Kotlin decodes the PushFrame and returns the ack bytes (b64) to
                // send back. Without acks TikTok stops pushing after a few frames.
                var ackB64 = SS.onWsFrame(b64(ab));
                if (ackB64) {
                    try {
                        ws.send(unb64(ackB64));
                        acked++;
                        if (acked <= 3) SS.onDebug('sent ack #' + acked);
                    } catch (e) {
                        SS.onDebug('ack send failed: ' + e.message);
                    }
                }
            }
            ws.addEventListener('message', function(ev) {
                try {
                    n++;
                    if (n <= 3 || n % 25 === 0) SS.onDebug('ws frame #' + n + ' type=' + (typeof ev.data) + ' ' + (ev.data && ev.data.constructor && ev.data.constructor.name));
                    if (ev.data instanceof ArrayBuffer) {
                        handle(ev.data);
                    } else if (ev.data instanceof Blob) {
                        ev.data.arrayBuffer().then(handle);
                    } else if (typeof ev.data === 'string') {
                        SS.onWsText(ev.data.slice(0, 4000));
                    }
                } catch (e) {}
            });
        } catch (e) {}
        return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;

    var origFetch = window.fetch;
    window.fetch = function(input, init) {
        var u = typeof input === 'string' ? input : (input && input.url) || '';
        var p = origFetch.apply(this, arguments);
        if (/webcast/i.test(u) && /im\/fetch|im\/push|message/i.test(u)) {
            SS.onDebug('fetch sniffed: ' + u.slice(0, 100));
            p = p.then(function(resp) {
                try {
                    resp.clone().arrayBuffer().then(function(ab) { SS.onWsFrame(b64(ab)); });
                } catch (e) {}
                return resp;
            });
        }
        return p;
    };

    var OrigXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        this.__ssUrl = String(url);
        return OrigXHROpen.apply(this, arguments);
    };
    var OrigXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
        var xhr = this;
        if (/webcast/i.test(xhr.__ssUrl || '') && /im\/fetch|im\/push|message/i.test(xhr.__ssUrl || '')) {
            SS.onDebug('xhr sniffed: ' + xhr.__ssUrl.slice(0, 100));
            xhr.addEventListener('load', function() {
                try {
                    if (xhr.response instanceof ArrayBuffer) SS.onWsFrame(b64(xhr.response));
                    else if (typeof xhr.response === 'string') SS.onWsText(xhr.response.slice(0, 4000));
                } catch (e) {}
            });
        }
        return OrigXHRSend.apply(this, arguments);
    };
})();
"""

        private const val OBSERVER_JS = """
(function() {
  if (window.__ssHooked) return 'already';
  window.__ssHooked = true;

    function findRoomId() {
        // 1) SIGI_STATE / __UNIVERSAL_DATA blobs
        try {
            var el = document.getElementById('SIGI_STATE');
            if (el) {
                var m = el.textContent.match(/"roomId"\s*:\s*"(\d{5,})"/);
                if (m) return m[1];
            }
        } catch (e) {}
        try {
            var el2 = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (el2) {
                var m2 = el2.textContent.match(/"roomId"\s*:\s*"(\d{5,})"/);
                if (m2) return m2[1];
            }
        } catch (e) {}
        // 2) anywhere in the HTML
        var m3 = document.documentElement.innerHTML.match(/room_id=(\d{5,})/) ||
                         document.documentElement.innerHTML.match(/"roomId"\s*:\s*"(\d{5,})"/);
        return m3 ? m3[1] : null;
    }

    var seen = new WeakSet();
    function emit(node) {
        if (seen.has(node)) return;
        seen.add(node);
        try {
            var text = node.innerText || '';
            var lines = text.split('\n').map(function(s){return s.trim();}).filter(Boolean);
            if (!lines.length) return;
            var user = lines[0];
            var msg = lines.slice(1).join(' ');
            if (!msg) { msg = user; user = '?'; }
            if (msg.length < 1 || user.length > 40) return;
            var kind = 'CHAT';
            var low = msg.toLowerCase();
            if (low.indexOf('joined') >= 0) kind = 'JOIN';
            else if (low.indexOf('followed') >= 0) kind = 'FOLLOW';
            else if (low.indexOf('sent') >= 0 || low.indexOf('gift') >= 0) kind = 'GIFT';
            else if (low.indexOf('liked') >= 0) kind = 'LIKE';
            SS.onMsg(JSON.stringify({user: user, text: msg, kind: kind}));
        } catch (e) {}
    }

    function hookDom() {
        var room = document.querySelector(
            '[class*="DivChatMessageList"], [class*="DivChatRoomContent"], [class*="ChatRoom"], ' +
            '[data-e2e="chat-room"], [id*="chatroom"]');
        if (!room) return false;
        SS.onDebug('hooked container: ' + (room.className || room.id).slice(0, 80));
        var obs = new MutationObserver(function(muts) {
            muts.forEach(function(m) {
                m.addedNodes.forEach(function(n) {
                    if (n.nodeType === 1) emit(n);
                });
            });
        });
        obs.observe(room, {childList: true, subtree: true});
        SS.onStatus('live');
        return true;
    }

    function startPolling(roomId) {
        SS.onDebug('polling room ' + roomId + ' via webview fetch');
        var cursor = '';
        var busy = false;
        setInterval(function() {
            if (busy) return;
            busy = true;
            var url = 'https://webcast.tiktok.com/webcast/im/fetch/?aid=1988&app_language=en&device_platform=web' +
                                '&room_id=' + roomId + '&cursor=' + encodeURIComponent(cursor) +
                                '&resp_content_type=json&fetch_rule=1&last_rtt=0&live_id=12&history_comment_count=6';
            fetch(url, {credentials: 'include'})
                .then(function(r) {
                    if (!r.ok) throw new Error('http ' + r.status);
                    return r.text();
                })
                .then(function(raw) {
                    var next = SS.onJson(raw);
                    if (next) cursor = next;
                    busy = false;
                })
                .catch(function(e) {
                    SS.onDebug('wv fetch fail: ' + String(e.message).slice(0, 60));
                    busy = false;
                });
        }, 1500);
    }

    var tries = 0;
    var iv = setInterval(function() {
        tries++;
        if (hookDom()) {
            clearInterval(iv);
            return;
        }
        var roomId = findRoomId();
        if (roomId) {
            clearInterval(iv);
            SS.onDebug('roomId=' + roomId + '; waiting for page WS/fetch traffic (sniffer)');
        } else if (tries > 45) {
            clearInterval(iv);
            var cls = [];
            document.querySelectorAll('div[class]').forEach(function(d) {
                if (/[Cc]hat/.test(d.className)) cls.push(d.className.slice(0, 70));
            });
            SS.onDebug('no chat container; roomId=' + findRoomId() + '; divs=' + document.querySelectorAll('div').length + '; chatDivs=' + cls.slice(0, 6).join(';'));
            SS.onStatus('error:chat container not found');
        } else if (tries % 10 === 0) {
            SS.onDebug('waiting for chat DOM… tries=' + tries + ' divs=' + document.querySelectorAll('div').length);
        }
    }, 1000);
    return 'hooked';
})();
"""

    private class Bridge {
        @JavascriptInterface
        fun onMsg(json: String) {
            try {
                val o = JSONObject(json)
                val kind = runCatching {
                    ChatMessage.Kind.valueOf(o.optString("kind", "CHAT"))
                }.getOrDefault(ChatMessage.Kind.CHAT)
                val user = o.optString("user").take(24)
                val text = o.optString("text").take(200)
                if (text.isBlank()) return
                push(ChatMessage(user, text, kind))
            } catch (e: Exception) {
                Log.w(TAG, "bad msg json", e)
            }
        }

        @JavascriptInterface
        fun onStatus(s: String) {
            Log.i(TAG, "status: $s")
            status.value = s
        }

        @JavascriptInterface
        fun onDebug(s: String) {
            Log.i(TAG, "debug: $s")
        }

        @JavascriptInterface
        fun onRoomId(roomId: String) {
            Log.i(TAG, "roomId: $roomId — starting native poller")
            val cookies = try {
                CookieManager.getInstance().getCookie("https://www.tiktok.com")
            } catch (e: Exception) {
                null
            }
            WebcastPoller.start(
                roomId, cookies,
                onMessage = { push(it) },
                onStatus = { status.value = it },
            )
        }

        /** Receives a base64 protobuf WebcastResponse frame; returns next cursor. */
        @JavascriptInterface
        fun onFrame(b64: String): String {
            return try {
                val data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                status.value = "live"
                WebcastPoller.decodeFrame(data) { push(it) }
            } catch (e: Exception) {
                Log.w(TAG, "frame decode failed", e)
                ""
            }
        }

        /** Receives the raw im/fetch JSON body; returns next cursor. Lenient parse. */
        @JavascriptInterface
        fun onJson(raw: String): String {
            return try {
                status.value = "live"
                val obj = JSONObject(raw)
                val data = obj.optJSONObject("data") ?: obj
                val cursor = data.optString("cursor", "")
                val arr = data.optJSONArray("messages") ?: data.optJSONArray("message")
                if (arr == null) {
                    val keys = mutableListOf<String>()
                    data.keys().forEach { keys.add(it) }
                    Log.i(TAG, "json keys: $keys")
                    return cursor
                }
                Log.i(TAG, "json frame: ${arr.length()} msgs")
                for (i in 0 until arr.length()) {
                    val m = arr.optJSONObject(i) ?: continue
                    if (i == 0) {
                        val ks = mutableListOf<String>()
                        m.keys().forEach { ks.add(it) }
                        Log.i(TAG, "msg[0] keys: $ks method=${m.optString("method")}")
                    }
                    val method = m.optString("method", m.optJSONObject("common")?.optString("method") ?: "")
                    val userObj = m.optJSONObject("user") ?: m.optJSONObject("chatUser")
                    val user = userObj?.optString("nickname")
                        ?: userObj?.optString("nickName") ?: "?"
                    when {
                        method.contains("ChatMessage") -> {
                            val content = m.optString("content")
                            if (content.isNotBlank()) push(ChatMessage(user, content, ChatMessage.Kind.CHAT))
                        }
                        method.contains("GiftMessage") -> {
                            val gift = m.optJSONObject("gift")?.optString("name") ?: "a gift"
                            push(ChatMessage(user, "sent $gift 🎁", ChatMessage.Kind.GIFT))
                        }
                        method.contains("SocialMessage") -> push(ChatMessage(user, "followed! ✨", ChatMessage.Kind.FOLLOW))
                        method.contains("MemberMessage") -> push(ChatMessage(user, "joined", ChatMessage.Kind.JOIN))
                    }
                }
                cursor
            } catch (e: Exception) {
                Log.w(TAG, "json parse failed: ${e.message}; head=${raw.take(120)}")
                ""
            }
        }

        /**
         * Sniffed webcast frame (WS binary or im/fetch response). May be gzip.
         * Returns base64 ack bytes the page must send back over the socket, or
         * "" when no ack is needed.
         */
        @JavascriptInterface
        fun onWsFrame(b64: String): String {
            try {
                var data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                if (data.size > 2 && data[0] == 0x1f.toByte() && data[1] == 0x8b.toByte()) {
                    data = java.util.zip.GZIPInputStream(data.inputStream()).readBytes()
                }
                status.value = "live"
                val ack = WebcastPoller.decodeAnyWithAck(data) { push(it) }
                return if (ack != null) {
                    android.util.Base64.encodeToString(ack, android.util.Base64.NO_WRAP)
                } else ""
            } catch (e: Exception) {
                Log.w(TAG, "ws frame decode failed: ${e.message}")
            }
            return ""
        }

        @JavascriptInterface
        fun onWsText(s: String) {
            Log.i(TAG, "ws text frame: ${s.take(200)}")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun connect(context: Context, username: String) {
        val user = username.removePrefix("@").trim()
        if (user.isEmpty()) return
        main.post {
            disconnectInternal()
            status.value = "connecting"
            val wv = WebView(context.applicationContext)
            webView = wv
            wv.settings.javaScriptEnabled = true
            wv.settings.domStorageEnabled = true
            wv.settings.mediaPlaybackRequiresUserGesture = true
            // Desktop UA: mobile TikTok web hides live chat behind an app wall.
            wv.settings.userAgentString =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            wv.settings.useWideViewPort = true
            wv.settings.loadWithOverviewMode = true
            wv.layout(0, 0, 1280, 800)
            wv.addJavascriptInterface(Bridge(), "SS")
            // Keep JS timers + WS alive while the WebView is offscreen — this is
            // what made "realtime" stall before.
            wv.onResume()
            wv.resumeTimers()
            wv.webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    // Inject the WS/fetch sniffer before page scripts run.
                    view.evaluateJavascript(SNIFFER_JS, null)
                }
                override fun onPageFinished(view: WebView, url: String) {
                    Log.i(TAG, "page finished: $url")
                    if (url.contains("/live")) {
                        view.evaluateJavascript(SNIFFER_JS, null)
                        view.evaluateJavascript(OBSERVER_JS, null)
                    }
                }
            }
            wv.loadUrl("https://www.tiktok.com/@$user/live")
        }
    }

    fun disconnect() {
        main.post { disconnectInternal() }
    }

    private fun disconnectInternal() {
        WebcastPoller.stop()
        webView?.let {
            it.loadUrl("about:blank")
            it.destroy()
        }
        webView = null
        buffer.clear()
        messages.value = emptyList()
        status.value = "offline"
    }

    private fun push(msg: ChatMessage) {
        buffer.add(msg)
        while (buffer.size > MAX_MESSAGES) buffer.removeAt(0)
        messages.value = buffer.toList()
    }
}
