package com.limenarc.llamaweb

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            webViewClient = WebViewClient()
            addJavascriptInterface(NativeBridge(this@MainActivity), "Native")
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(webView)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    /**
     * Bridge exposed to assets/index.html as `window.Native`. Phase 1 wires the plumbing
     * only; real implementations land in later phases (server lifecycle, model directory
     * picker, etc).
     *
     * Must not be a private class: WebView's JS bridge invokes these methods via
     * reflection, and a private declaring class can trip IllegalAccessException on some
     * WebView/Chromium builds even though the methods themselves are public.
     */
    class NativeBridge(private val activity: MainActivity) {

        @JavascriptInterface
        fun listModels(): String {
            return "[]"
        }

        @JavascriptInterface
        fun startServer(configJson: String): String {
            return """{"ok":false,"error":"not implemented yet"}"""
        }

        @JavascriptInterface
        fun stopServer() {
            // no-op until Phase 2
        }

        @JavascriptInterface
        fun serverStatus(): String {
            return """{"state":"stopped"}"""
        }

        @JavascriptInterface
        fun pickModelsDir() {
            // no-op until Phase 2 (MANAGE_EXTERNAL_STORAGE + directory picker)
        }
    }
}
