package com.limenarc.llamaweb

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var manageStorageLauncher: ActivityResultLauncher<Intent>
    private lateinit var notificationPermLauncher: ActivityResultLauncher<String>

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        manageStorageLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (hasAllFilesAccess()) {
                showModelsDirDialog()
            } else {
                notifyModelsDirResult(null, "All-files access was not granted")
            }
        }
        notificationPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // Best-effort: the foreground service still runs without this, it just won't
            // show a visible notification.
        }

        val isDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (isDebuggable) {
            // Lets a computer with adb + chrome://inspect see the live DOM and console for
            // this WebView - the only way to actually debug page issues found on-device.
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            // index.html/style.css/app.js are loaded from the same file:// URL on every
            // build, so nothing else invalidates a prior install's cached copies of them -
            // every APK update needs the freshest assets, not whatever an old build cached.
            settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            clearCache(true)
            webViewClient = WebViewClient()
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    if (isDebuggable) {
                        Log.d("WebConsole", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                    }
                    return true
                }
            }
            addJavascriptInterface(NativeBridge(this@MainActivity), "Native")
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(webView)

        // Apps targeting API 35 get edge-to-edge enforced by the OS on Android 15+: content
        // draws behind the status bar and navigation bar by default, and the app is
        // responsible for insetting around them. Without this, the topbar (which sits right
        // at the very top of the page) renders partly or fully underneath the status bar -
        // present but not visibly readable or tappable.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    override fun onDestroy() {
        // The foreground service exists to survive *backgrounding*; actual destruction means
        // the user is done with the app, so tear the child process down rather than leak it.
        LlamaProcessManager.stop()
        LlamaForegroundService.stop(this)
        webView.destroy()
        super.onDestroy()
    }

    // --- models directory picking -------------------------------------------------------

    fun beginPickModelsDir() {
        if (!hasAllFilesAccess()) {
            val intent = try {
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
            } catch (e: ActivityNotFoundException) {
                Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
            }
            manageStorageLauncher.launch(intent)
            return
        }
        showModelsDirDialog()
    }

    private fun hasAllFilesAccess(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

    private fun showModelsDirDialog() {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val current = prefs.getString(KEY_MODELS_DIR, null) ?: Environment.getExternalStorageDirectory().absolutePath

        val input = EditText(this).apply {
            setText(current)
            setSelection(text.length)
        }
        val paddingPx = (20 * resources.displayMetrics.density).toInt()
        val container = FrameLayout(this).apply {
            setPadding(paddingPx, paddingPx / 2, paddingPx, 0)
            addView(input)
        }

        AlertDialog.Builder(this)
            .setTitle("Models directory")
            .setMessage("Absolute path to the folder containing your .gguf files")
            .setView(container)
            .setPositiveButton("OK") { _, _ ->
                val path = input.text.toString().trim()
                val dir = File(path)
                if (dir.isDirectory && dir.canRead()) {
                    prefs.edit().putString(KEY_MODELS_DIR, path).apply()
                    notifyModelsDirResult(path, null)
                } else {
                    notifyModelsDirResult(null, "not a readable directory: $path")
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun notifyModelsDirResult(path: String?, error: String?) {
        val payload = JSONObject().apply {
            put("path", path)
            put("error", error)
        }
        webView.post {
            webView.evaluateJavascript("window.onModelsDirPicked && window.onModelsDirPicked($payload);", null)
        }
    }

    // --- server lifecycle ------------------------------------------------------------------

    fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    fun dispatchStartServer(modelPath: String, port: Int, contextSize: Int, ngl: Int, loraSpecs: List<Pair<String, Float?>>) {
        // ActivityResultLauncher.launch() and starting the foreground service both require the
        // main thread; this is called from the WebView's JS-interface thread, not the UI thread.
        runOnUiThread {
            requestNotificationPermissionIfNeeded()
            LlamaForegroundService.start(this)
        }
        Thread(
            {
                LlamaProcessManager.start(applicationContext, modelPath, port, contextSize, ngl, loraSpecs)
                runOnUiThread { LlamaForegroundService.refresh(this) }
            },
            "llama-start-dispatch",
        ).start()
    }

    fun dispatchStopServer() {
        Thread(
            {
                LlamaProcessManager.stop()
                runOnUiThread { LlamaForegroundService.refresh(this) }
            },
            "llama-stop-dispatch",
        ).start()
    }

    companion object {
        private const val PREFS_NAME = "llama_webview_prefs"
        private const val KEY_MODELS_DIR = "models_dir"
    }

    /**
     * Bridge exposed to assets/index.html as `window.Native`.
     *
     * Must not be a private class: WebView's JS bridge invokes these methods via
     * reflection, and a private declaring class can trip IllegalAccessException on some
     * WebView/Chromium builds even though the methods themselves are public.
     */
    class NativeBridge(private val activity: MainActivity) {

        @JavascriptInterface
        fun listModels(): String {
            val prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val dirPath = prefs.getString(KEY_MODELS_DIR, null) ?: return "[]"
            val root = File(dirPath)
            if (!root.isDirectory) return "[]"

            val results = JSONArray()
            root.walkTopDown()
                .maxDepth(6)
                .filter { it.isFile && it.extension.equals("gguf", ignoreCase = true) }
                .forEach { f ->
                    results.put(
                        JSONObject().apply {
                            put("path", f.absolutePath)
                            put("name", f.name)
                            put("sizeBytes", f.length())
                        }
                    )
                }
            return results.toString()
        }

        @JavascriptInterface
        fun startServer(configJson: String): String {
            val cfg = try {
                JSONObject(configJson)
            } catch (e: Exception) {
                return errorJson("invalid JSON: ${e.message}")
            }

            val modelPath = cfg.optString("modelPath", "")
            if (modelPath.isBlank()) return errorJson("modelPath is required")
            if (!File(modelPath).canRead()) return errorJson("model file not readable: $modelPath")

            val port = cfg.optInt("port", 8080)
            val contextSize = cfg.optInt("contextSize", 4096)
            val ngl = cfg.optInt("ngl", 99)

            val loraSpecs = mutableListOf<Pair<String, Float?>>()
            cfg.optJSONArray("lora")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val entry = arr.getJSONObject(i)
                    val path = entry.getString("path")
                    val scale = if (entry.has("scale") && !entry.isNull("scale")) {
                        entry.getDouble("scale").toFloat()
                    } else {
                        null
                    }
                    loraSpecs += path to scale
                }
            }

            activity.dispatchStartServer(modelPath, port, contextSize, ngl, loraSpecs)
            return JSONObject().apply {
                put("ok", true)
                put("state", "starting")
            }.toString()
        }

        @JavascriptInterface
        fun stopServer() {
            activity.dispatchStopServer()
        }

        @JavascriptInterface
        fun serverStatus(): String {
            val status = LlamaProcessManager.status()
            return JSONObject().apply {
                put("state", status.state.name.lowercase())
                put("port", status.port)
                put("modelPath", status.modelPath)
                put("error", status.error)
            }.toString()
        }

        @JavascriptInterface
        fun getLog(): String = LlamaProcessManager.logTail(200)

        @JavascriptInterface
        fun pickModelsDir() {
            activity.runOnUiThread { activity.beginPickModelsDir() }
        }

        private fun errorJson(message: String): String =
            JSONObject().apply { put("ok", false); put("error", message) }.toString()
    }
}
