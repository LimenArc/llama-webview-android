package com.limenarc.llamaweb

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Exists only to keep the app process at foreground priority while llama-server is running, so
 * the OS is much less likely to kill the whole process (and the llama-server child it spawned)
 * just because the Activity is backgrounded. It does not itself own the process - that's
 * [LlamaProcessManager], a plain singleton, so its lifecycle is independent of this Service's.
 */
class LlamaForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_NOT_STICKY
    }

    private fun buildNotification(): Notification {
        val channelId = ensureChannel()
        val status = LlamaProcessManager.status()
        val text = when (status.state) {
            ServerState.RUNNING -> "Running on 127.0.0.1:${status.port}"
            ServerState.STARTING -> "Starting on port ${status.port}…"
            ServerState.FAILED -> "Failed to start"
            ServerState.STOPPED -> "Stopped"
        }
        val contentIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("llama-server")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }

    private fun ensureChannel(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "llama-server status", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
        return CHANNEL_ID
    }

    companion object {
        private const val CHANNEL_ID = "llama_server_status"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            val intent = Intent(context, LlamaForegroundService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LlamaForegroundService::class.java))
        }

        /** Call after a status change so the persistent notification reflects the new state. */
        fun refresh(context: Context) {
            if (LlamaProcessManager.status().state == ServerState.STOPPED) {
                stop(context)
            } else {
                start(context)
            }
        }
    }
}
