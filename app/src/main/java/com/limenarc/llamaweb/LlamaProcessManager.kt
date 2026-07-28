package com.limenarc.llamaweb

import android.content.Context
import android.util.Log
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

enum class ServerState {
    STOPPED, STARTING, RUNNING, FAILED
}

data class ServerStatus(
    val state: ServerState,
    val port: Int?,
    val modelPath: String?,
    val error: String?,
)

/**
 * Owns the llama-server child process end to end: building argv, launching it, draining its
 * output into a ring buffer, and polling /health until it's actually ready to serve requests.
 *
 * A process-wide singleton on purpose: there is only ever one llama-server instance running,
 * and both the WebView bridge and the foreground service need to see the same state.
 */
object LlamaProcessManager {
    private const val TAG = "LlamaProcessManager"
    private const val HEALTH_TIMEOUT_MS = 60_000L
    private const val LOG_TAIL_LINES = 40

    private val lock = Any()
    private var process: Process? = null
    private var logThread: Thread? = null
    private val logBuffer = LogRingBuffer(500)

    @Volatile private var state: ServerState = ServerState.STOPPED
    @Volatile private var port: Int? = null
    @Volatile private var modelPath: String? = null
    @Volatile private var lastError: String? = null
    @Volatile private var stopRequested: Boolean = false

    fun status(): ServerStatus = ServerStatus(state, port, modelPath, lastError)

    fun logTail(maxLines: Int = LOG_TAIL_LINES): String = logBuffer.tail(maxLines)

    /**
     * Builds argv, launches llama-server, and blocks (with a 60s ceiling) until /health
     * responds or the attempt fails. Blocking is intentional here - see NativeBridge for how
     * this is dispatched off the WebView's JS-interface thread so a slow model load doesn't
     * hang page JS for a minute. Restarting (e.g. for a new adapter set) just calls this again;
     * any existing process is stopped first.
     */
    @Synchronized
    fun start(
        context: Context,
        modelPath: String,
        port: Int,
        contextSize: Int,
        ngl: Int,
        loraSpecs: List<Pair<String, Float?>>,
    ): Result<Unit> {
        stop()
        stopRequested = false

        synchronized(lock) {
            state = ServerState.STARTING
            lastError = null
            logBuffer.clear()
            this.port = port
            this.modelPath = modelPath
        }

        val binary = File(context.applicationInfo.nativeLibraryDir, "libllama-server.so")
        if (!binary.canExecute()) {
            val err = "server binary missing or not executable at ${binary.absolutePath}"
            synchronized(lock) { state = ServerState.FAILED; lastError = err }
            return Result.failure(IOException(err))
        }

        val argv = mutableListOf(
            binary.absolutePath,
            "--model", modelPath,
            "--host", "127.0.0.1",
            "--port", port.toString(),
            "--ctx-size", contextSize.toString(),
            "--n-gpu-layers", ngl.toString(),
        )
        for ((path, scale) in loraSpecs) {
            if (scale != null) {
                argv += listOf("--lora-scaled", path, scale.toString())
            } else {
                argv += listOf("--lora", path)
            }
        }

        val proc = try {
            ProcessBuilder(argv)
                .redirectErrorStream(true)
                .directory(context.filesDir)
                .start()
        } catch (e: IOException) {
            synchronized(lock) { state = ServerState.FAILED; lastError = e.message ?: "failed to launch process" }
            return Result.failure(e)
        }

        synchronized(lock) { process = proc }

        val adapterError = AtomicReference<String?>(null)

        val drainThread = thread(name = "llama-server-log", isDaemon = true) {
            try {
                proc.inputStream.bufferedReader().forEachLine { line ->
                    logBuffer.add(line)
                    if (isAdapterRejection(line)) {
                        adapterError.compareAndSet(null, line)
                    }
                }
            } catch (e: IOException) {
                Log.w(TAG, "log drain thread ended: ${e.message}")
            }
        }
        synchronized(lock) { logThread = drainThread }

        val deadline = System.currentTimeMillis() + HEALTH_TIMEOUT_MS
        var delayMs = 200L
        var healthy = false
        while (System.currentTimeMillis() < deadline) {
            if (adapterError.get() != null) break
            if (!proc.isAlive) break
            if (pingHealth(port)) {
                healthy = true
                break
            }
            Thread.sleep(delayMs)
            delayMs = (delayMs * 2).coerceAtMost(2_000L)
        }

        if (healthy) {
            synchronized(lock) { state = ServerState.RUNNING }
            return Result.success(Unit)
        }

        if (stopRequested) {
            // A concurrent stop() already tore this attempt down and set state = STOPPED;
            // that's not a failure, so leave it alone rather than reporting FAILED.
            return Result.failure(IOException("start cancelled by stop()"))
        }

        val reason = when {
            adapterError.get() != null -> "adapter rejected: ${adapterError.get()}"
            !proc.isAlive -> "llama-server exited early (code ${runCatching { proc.exitValue() }.getOrDefault(-1)})"
            else -> "server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s"
        }
        val tail = logBuffer.tail(LOG_TAIL_LINES)
        val message = if (tail.isBlank()) reason else "$reason\n\n--- log tail ---\n$tail"
        synchronized(lock) { state = ServerState.FAILED; lastError = message }
        stopInternal()
        return Result.failure(IOException(message))
    }

    // Deliberately not synchronized on the same monitor as start(): stop() must be able to
    // interrupt an in-flight start() (e.g. a slow model load still health-polling) rather than
    // block for up to 60s waiting for it to finish on its own. Killing the process here makes
    // the health-poll loop in start() observe `!proc.isAlive` and exit promptly.
    fun stop() {
        stopRequested = true
        stopInternal()
        synchronized(lock) {
            if (state != ServerState.FAILED) {
                state = ServerState.STOPPED
            }
        }
    }

    private fun stopInternal() {
        val proc = synchronized(lock) { process }
        if (proc != null) {
            proc.destroy()
            try {
                if (!proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    proc.destroyForcibly()
                    proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
                }
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        synchronized(lock) {
            logThread?.interrupt()
            logThread = null
            process = null
        }
    }

    private fun isAdapterRejection(line: String): Boolean {
        val lower = line.lowercase()
        val mentionsAdapter = "lora" in lower || "adapter" in lower
        val mentionsFailure = listOf("fail", "error", "reject", "invalid", "incompatib", "unable to apply")
            .any { it in lower }
        return mentionsAdapter && mentionsFailure
    }

    private fun pingHealth(port: Int): Boolean {
        return try {
            val conn = URL("http://127.0.0.1:$port/health").openConnection() as HttpURLConnection
            conn.connectTimeout = 500
            conn.readTimeout = 500
            conn.requestMethod = "GET"
            val code = conn.responseCode
            conn.disconnect()
            code in 200..299
        } catch (e: IOException) {
            false
        }
    }
}
