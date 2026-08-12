package ro.codai.selfiescreen

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity

/**
 * Visible WebView for a one-time TikTok web login. Cookies are stored in the
 * app's shared WebView cookie jar, so the hidden live-chat WebView picks up
 * the authenticated session automatically afterwards.
 */
class TikTokLoginActivity : ComponentActivity() {

    companion object {
        private const val TAG = "TikTokLogin"

        /** True when the WebView cookie jar holds a TikTok session. */
        fun isLoggedIn(): Boolean {
            val cookies = CookieManager.getInstance().getCookie("https://www.tiktok.com") ?: return false
            return cookies.contains("sessionid=")
        }
    }

    private lateinit var webView: WebView
    private lateinit var banner: TextView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0B0E14"))
        }
        banner = TextView(this).apply {
            text = "Sign in to TikTok — this window closes automatically"
            setTextColor(Color.parseColor("#8B93A7"))
            setBackgroundColor(Color.parseColor("#141926"))
            textSize = 13f
            setPadding(40, 30, 40, 30)
        }
        webView = WebView(this)
        root.addView(banner)
        root.addView(
            webView,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        )
        setContentView(root)

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        // TikTok blocks logins from WebViews ("; wv" UA marker) → present as Chrome Mobile.
        webView.settings.userAgentString = webView.settings.userAgentString
            .replace("; wv", "")
            .replace(Regex("Version/\\d+\\.\\d+ "), "")
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                CookieManager.getInstance().flush()
                if (isLoggedIn()) {
                    Log.i(TAG, "session cookie detected — closing")
                    banner.text = "Signed in ✓"
                    banner.postDelayed({ finish() }, 600)
                }
            }
        }
        webView.loadUrl("https://www.tiktok.com/login")
    }

    override fun onDestroy() {
        CookieManager.getInstance().flush()
        webView.destroy()
        super.onDestroy()
    }
}
