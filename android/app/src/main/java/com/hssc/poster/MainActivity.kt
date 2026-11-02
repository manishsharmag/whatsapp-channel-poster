package com.hssc.poster

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.net.InetSocketAddress
import java.net.Socket

/**
 * One screen: the existing Control Panel inside a WebView. Everything else —
 * the scheduler, the banks, WhatsApp — is still the same JavaScript.
 *
 * Node needs a few seconds (tens on the first launch) before it binds the port,
 * so the WebView is only pointed at it once a socket actually connects. Loading
 * earlier would paint Chrome's "Webpage not available" page, which also fires
 * onPageFinished and used to stop the retry loop for good.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var loader: LinearLayout
    private lateinit var loaderText: TextView
    private lateinit var logsButton: Button
    private val handler = Handler(Looper.getMainLooper())

    @Volatile
    private var loaded = false
    private var mainFrameFailed = false
    private var probe: Thread? = null

    private val panelUrl = "http://127.0.0.1:$PANEL_PORT/"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.textZoom = 100
            isVerticalScrollBarEnabled = true
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
            setBackgroundColor(BG)
            visibility = View.INVISIBLE
        }
        // Debug builds can be inspected over adb; release builds cannot.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                mainFrameFailed = false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                if (mainFrameFailed) return
                if (url?.startsWith(panelUrl) != true) return
                loaded = true
                loader.visibility = View.GONE
                webView.visibility = View.VISIBLE
                maybeOfferBackground()
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame != true) return
                mainFrameFailed = true
                loaded = false
                // Brief back-off so a persistent failure cannot become a reload loop.
                handler.postDelayed({ if (!loaded) showLoader("Reconnecting to the poster…") }, 1200)
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val target = request?.url?.toString() ?: return false
                return openOutside(target)
            }
        }

        loader = buildLoader()

        val content = FrameLayout(this).apply {
            addView(webView, FrameLayout.LayoutParams(MATCH, MATCH))
            addView(loader, FrameLayout.LayoutParams(MATCH, MATCH))
        }

        logsButton = Button(this).apply {
            text = "Logs"
            setOnClickListener { showLogs() }
        }
        val settingsButton = Button(this).apply {
            text = "Settings"
            setOnClickListener { showSettings() }
        }
        val reloadButton = Button(this).apply {
            text = "Reload"
            setOnClickListener { showLoader("Reloading…") }
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(logsButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(settingsButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(reloadButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }

        root.addView(content, LinearLayout.LayoutParams(MATCH, 0, 1f))
        root.addView(bar, LinearLayout.LayoutParams(MATCH, LinearLayout.LayoutParams.WRAP_CONTENT))
        setContentView(root)

        com.hssc.poster.NodeService.start(this)
        showLoader("Starting the poster…")
    }

    /** Dark, centred boot screen: a spinner and one honest status line. */
    private fun buildLoader(): LinearLayout {
        val spinner = ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = android.content.res.ColorStateList.valueOf(ACCENT)
        }
        val title = TextView(this).apply {
            text = "HSSC Poster"
            setTextColor(Color.WHITE)
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        loaderText = TextView(this).apply {
            text = "Starting the poster…"
            setTextColor(MUTED)
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(48, 18, 48, 0)
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(BG)
            addView(spinner, LinearLayout.LayoutParams(56, 56))
            addView(title, LinearLayout.LayoutParams(MATCH, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = 22 })
            addView(loaderText, LinearLayout.LayoutParams(MATCH, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
    }

    /**
     * Shows the boot screen and waits until Node's port accepts a connection.
     * Only then does the WebView navigate — a refused connection would leave a
     * Chrome error page behind, not a retry.
     */
    private fun showLoader(message: String) {
        loaded = false
        loaderText.text = message
        loader.visibility = View.VISIBLE
        webView.visibility = View.INVISIBLE
        if (probe?.isAlive == true) return
        probe = Thread({ waitForServer() }, "panel-wait").also { it.start() }
    }

    private fun waitForServer() {
        var waited = 0
        while (!loaded) {
            val up = try {
                Socket().use { it.connect(InetSocketAddress("127.0.0.1", PANEL_PORT), 400); true }
            } catch (_: Exception) {
                false
            }
            if (up) {
                handler.post {
                    if (loaded) return@post
                    loaderText.text = "Loading the panel…"
                    webView.loadUrl(panelUrl)
                }
                return
            }
            waited += 400
            if (waited == 5000) {
                handler.post {
                    if (!loaded) loaderText.text = "Still starting — the first launch unpacks the question banks…"
                }
            }
            if (waited >= 180_000) {
                handler.post {
                    if (!loaded) {
                        loaderText.text = "Node is not answering.\nTap Logs to see why, or Reload to try again."
                    }
                }
                return
            }
            try {
                Thread.sleep(400)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    /** The activity may come back from the background while Node is still starting. */
    override fun onResume() {
        super.onResume()
        if (!loaded) showLoader("Starting the poster…")
    }

    private fun openOutside(target: String): Boolean {
        if (target.startsWith("http://127.0.0.1") || target.startsWith("http://localhost")) {
            return false
        }
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target)))
            true
        } catch (_: Exception) {
            true
        }
    }

    /**
     * The two phone-level choices that decide whether a schedule actually runs:
     * start after a reboot, and be exempt from battery optimisation.
     */
    private fun showSettings() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 24, 48, 8)
        }

        val autoStart = CheckBox(this).apply {
            text = "Start automatically after a reboot"
            isChecked = Prefs.autoStart(this@MainActivity)
            setOnCheckedChangeListener { _, checked -> Prefs.setAutoStart(this@MainActivity, checked) }
        }
        box.addView(autoStart)

        val status = TextView(this).apply {
            textSize = 12.5f
            setPadding(0, 20, 0, 0)
            setTextColor(MUTED)
        }
        box.addView(status)

        val button = Button(this).apply {
            text = "Allow background activity"
            setOnClickListener {
                requestBackgroundExemption()
                handler.postDelayed({ refreshBackgroundStatus(status) }, 800)
            }
        }
        box.addView(button)

        val hint = TextView(this).apply {
            text = listOf(
                "Without this, Android can freeze the poster while the screen is off,",
                "and a 50-question run stops halfway. The app asks once; the setting",
                "lives in Android's battery settings, not here.",
            ).joinToString(" ")
            textSize = 12f
            setTextColor(MUTED)
            setPadding(0, 16, 0, 0)
        }
        box.addView(hint)

        refreshBackgroundStatus(status)

        AlertDialog.Builder(this)
            .setTitle("Settings")
            .setView(ScrollView(this).apply { addView(box) })
            .setPositiveButton("Close", null)
            .show()
    }

    private fun ignoringBatteryOptimizations(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = getSystemService(PowerManager::class.java) ?: return true
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    private fun refreshBackgroundStatus(view: TextView) {
        view.text = if (ignoringBatteryOptimizations()) {
            "✓ Background activity is allowed — the poster can finish a run with the screen off."
        } else {
            "⚠️ Battery optimisation is still on. Android may stop a run while the screen is off."
        }
    }

    private fun requestBackgroundExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (ignoringBatteryOptimizations()) return
        try {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName"),
                ),
            )
        } catch (_: Exception) {
            // Some OEM builds hide the direct request; the list still works.
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {
                // Nothing more we can do from here.
            }
        }
    }

    /** Asked once, after the panel first loads, so the user knows why it matters. */
    private fun maybeOfferBackground() {
        if (Prefs.askedBackground(this)) return
        Prefs.markAskedBackground(this)
        if (ignoringBatteryOptimizations()) return
        AlertDialog.Builder(this)
            .setTitle("Keep the poster awake")
            .setMessage(
                "A daily run takes about 17 minutes. If Android puts the app to sleep, "
                    + "questions stop arriving.\n\nAllow the poster to run in the background?"
            )
            .setPositiveButton("Allow") { _, _ -> requestBackgroundExemption() }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun showLogs() {
        val view = ScrollView(this)
        val text = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setPadding(24, 24, 24, 24)
            text = NodeService.snapshot().joinToString("\n").ifBlank { "(nothing yet — Node is still starting)" }
        }
        view.addView(text)

        AlertDialog.Builder(this)
            .setTitle("Poster log")
            .setView(view)
            .setPositiveButton("Close", null)
            .setNeutralButton("Share") { _, _ ->
                val body = NodeService.snapshot().joinToString("\n")
                val share = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, body)
                }
                startActivity(Intent.createChooser(share, "Share log"))
            }
            .show()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        private const val PANEL_PORT = 8777
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private val BG = Color.rgb(15, 17, 21)
        private val MUTED = Color.rgb(139, 148, 167)
        private val ACCENT = Color.rgb(37, 211, 102)
    }
}
