package com.hssc.poster

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.zip.ZipInputStream

/**
 * Owns the Node process for the lifetime of the app.
 *
 * Android kills background work, and a 50-question run takes ~17 minutes, so
 * Node runs inside a foreground service with a permanent notification.
 */
class NodeService : Service() {

    companion object {
        const val ACTION_START = "com.hssc.poster.START"
        const val ACTION_STOP = "com.hssc.poster.STOP"
        private const val CHANNEL_ID = "poster"
        private const val NOTIFICATION_ID = 1
        private const val MAX_RESTARTS = 4

        /** Shared with the UI so it can show Node's output. */
        private val logLines = ArrayDeque<String>()
        @Volatile var running = false
        @Volatile var lastLine = ""
        @Volatile var listener: ((String) -> Unit)? = null

        fun snapshot(): List<String> = synchronized(logLines) { logLines.toList() }

        private fun addLine(line: String) {
            synchronized(logLines) {
                if (logLines.size > 800) logLines.removeFirst()
                logLines.addLast(line)
            }
            lastLine = line
            listener?.invoke(line)
        }

        fun start(context: Context) {
            val intent = Intent(context, NodeService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, NodeService::class.java).setAction(ACTION_STOP))
        }
    }

    private var worker: Thread? = null
    private var tailer: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var lastNotifyAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        startInForeground("Starting…")
        acquireWakeLock()

        if (worker == null) {
            val appDir = AppFiles.ensure(this)
            startTailer(File(appDir, "node.log"))
            worker = Thread({ runNode(appDir) }, "node").also { it.start() }
        }
        return START_STICKY
    }

    private fun runNode(appDir: File) {
        val entry = File(appDir, "android/start.js")
        if (!entry.exists()) {
            addLine("[app] start.js is missing from the bundle — rebuild app.zip")
            return
        }

        var attempt = 0
        while (!Thread.currentThread().isInterrupted) {
            running = true
            try {
                addLine("[app] starting Node ${Build.SUPPORTED_ABIS.firstOrNull() ?: ""}")
                val code = NodeRunner.startNode(
                    arrayOf(
                        "node",
                        "--experimental-global-webcrypto",
                        entry.absolutePath,
                    ),
                )
                addLine("[app] Node exited with code $code")
            } catch (err: Throwable) {
                addLine("[app] Node crashed: ${err.message}")
            } finally {
                running = false
            }

            if (Thread.currentThread().isInterrupted) break

            // A crash at 08:00 would otherwise lose the whole day. Retry a few
            // times with a widening gap, then leave it stopped and say so.
            attempt += 1
            if (attempt > MAX_RESTARTS) {
                updateNotification("Stopped — tap Logs to see why")
                addLine("[app] giving up after $MAX_RESTARTS restarts")
                break
            }
            val waitMs = 5_000L * attempt
            addLine("[app] restarting Node in ${waitMs / 1000}s (attempt $attempt/$MAX_RESTARTS)")
            try {
                Thread.sleep(waitMs)
            } catch (_: InterruptedException) {
                break
            }
        }

        releaseWakeLock()
    }

    /**
     * Node writes its console to a file (see android/start.js); tail it so the
     * pairing code and the posting log are visible in the app.
     */
    private fun startTailer(logFile: File) {
        if (tailer != null) return
        tailer = Thread({
            var position = 0L
            while (!Thread.currentThread().isInterrupted) {
                try {
                    if (logFile.exists()) {
                        if (logFile.length() < position) position = 0
                        if (logFile.length() > position) {
                            logFile.bufferedReader().use { reader ->
                                reader.skip(position)
                                var line = reader.readLine()
                                while (line != null) {
                                    if (line.isNotBlank()) {
                                        addLine(line)
                                        if (line.contains("PAIRING CODE")) {
                                            updateNotification("Pairing code ready")
                                            lastNotifyAt = System.currentTimeMillis()
                                        } else if (System.currentTimeMillis() - lastNotifyAt > 10_000) {
                                            // A quiet tap on the notification showing what
                                            // the poster is doing right now (Q12/50, digest sent…).
                                            lastNotifyAt = System.currentTimeMillis()
                                            updateNotification(line.trim().take(90))
                                        }
                                    }
                                    line = reader.readLine()
                                }
                                position = logFile.length()
                            }
                        }
                    }
                } catch (_: Exception) {
                    // The file may be replaced while Node starts; just retry.
                }
                Thread.sleep(400)
            }
        }, "log-tail").also { it.isDaemon = true; it.start() }
    }

    /**
     * A run lasts ~17 minutes with the screen off, which is exactly when Doze
     * would freeze the process. Hold a partial wake lock for the time Node runs.
     */
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val manager = getSystemService(PowerManager::class.java)
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HSSCPoster:run").apply {
            setReferenceCounted(false)
            acquire(6 * 60 * 60 * 1000L)
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
            // Already released with the process.
        }
        wakeLock = null
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Poster service",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps the poster running while it sends questions"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, NodeService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("HSSC Poster")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(
                Notification.Action.Builder(
                    android.graphics.drawable.Icon.createWithResource(
                        this,
                        android.R.drawable.ic_menu_close_clear_cancel,
                    ),
                    "Stop",
                    stop,
                ).build(),
            )
            .build()
    }

    private fun startInForeground(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    override fun onDestroy() {
        worker?.interrupt()
        tailer?.interrupt()
        releaseWakeLock()
        running = false
        super.onDestroy()
    }
}

/**
 * Copies the JavaScript bundle out of the APK on first launch (and after an
 * update) and points the config at the copies of the question banks.
 */
object AppFiles {

    fun ensure(context: Context): File {
        val dir = File(context.filesDir, "app")
        val info = try {
            context.packageManager.getPackageInfo(context.packageName, 0)
        } catch (_: Exception) {
            null
        }
        // lastUpdateTime changes on every install, even at the same versionCode,
        // so a rebuilt bundle is always unpacked.
        val stampValue = "${info?.versionCode ?: 0}-${info?.lastUpdateTime ?: 0}"
        val stamp = File(dir, ".bundle")
        if (stamp.exists() && stamp.readText().trim() == stampValue && File(dir, "android/start.js").exists()) {
            return dir
        }

        // Updating the app must never wipe the WhatsApp link or the progress.
        val preserved = listOf("auth", "state", "config.json")
        val holding = File(context.filesDir, "bundle-keep")
        holding.deleteRecursively()
        holding.mkdirs()
        for (name in preserved) {
            val from = File(dir, name)
            if (from.exists()) {
                try {
                    from.copyRecursively(File(holding, name), overwrite = true)
                } catch (_: Exception) {
                    // Nothing to preserve yet.
                }
            }
        }

        dir.deleteRecursively()
        dir.mkdirs()
        context.assets.open("app.zip").use { input ->
            ZipInputStream(input).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    // Windows-created zips may use '\' as the separator; on
                    // Android that would become part of the file name.
                    val name = entry.name.replace('\\', '/')
                    val target = File(dir, name)
                    // Never let a zip entry escape the app directory.
                    if (!target.canonicalPath.startsWith(dir.canonicalPath + File.separator)) {
                        continue
                    }
                    if (entry.isDirectory) {
                        target.mkdirs()
                    } else {
                        target.parentFile?.mkdirs()
                        target.outputStream().use { out -> zip.copyTo(out) }
                    }
                    zip.closeEntry()
                }
            }
        }

        for (name in preserved) {
            val from = File(holding, name)
            if (from.exists()) {
                try {
                    from.copyRecursively(File(dir, name), overwrite = true)
                } catch (_: Exception) {
                    // Keep going: a broken config is better than a broken app.
                }
            }
        }
        holding.deleteRecursively()

        stamp.writeText(stampValue)
        rewriteConfig(dir)
        return dir
    }

    /** The banks live inside the APK, so their absolute paths change per device. */
    private fun rewriteConfig(dir: File) {
        val configFile = File(dir, "config.json")
        if (!configFile.exists()) return
        try {
            val config = JSONObject(configFile.readText())
            val bankDir = File(dir, "banks")
            val banks = JSONArray()
            bankDir.listFiles { f -> f.isFile && f.name.endsWith(".json") }
                ?.sortedBy { it.name }
                ?.forEach { banks.put(it.absolutePath) }
            if (banks.length() > 0) config.put("bankPaths", banks)
            configFile.writeText(config.toString(2))
        } catch (err: Exception) {
            File(dir, "node.log").appendText("[app] could not rewrite config: ${err.message}\n")
        }
    }
}
