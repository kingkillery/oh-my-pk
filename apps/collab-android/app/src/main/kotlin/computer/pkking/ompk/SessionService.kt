package computer.pkking.ompk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Holds the process awake while a session is open and the screen is off.
 *
 * The notification text is a fixed label. The session link is never an extra.
 */
class SessionService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannels(this)
        val label = sanitize(intent?.getStringExtra(EXTRA_LABEL))
        startForeground(
            ONGOING_ID,
            ongoing(this, label),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
        acquire()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun acquire() {
        if (wakeLock?.isHeld == true) return
        val power = getSystemService(PowerManager::class.java) ?: return
        val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ompk:session")
        lock.setReferenceCounted(false)
        lock.acquire()
        wakeLock = lock
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        if (lock.isHeld) lock.release()
        wakeLock = null
    }

    companion object {
        private const val EXTRA_LABEL = "label"
        private const val ONGOING_ID = 41
        private const val ATTENTION_ID = 42
        private const val CHANNEL_ONGOING = "session"
        private const val CHANNEL_ATTENTION = "attention"

        private val LABELS = setOf(
            "Connecting",
            "Live",
            "Working",
            "Host away",
            "Reconnecting",
            "Room closed",
            "Ended",
            "Needs input",
        )

        fun start(context: Context, label: String) {
            val intent = Intent(context, SessionService::class.java).putExtra(EXTRA_LABEL, sanitize(label))
            ContextCompat.startForegroundService(context, intent)
        }

        fun alert(context: Context, attention: Attention) {
            createChannels(context)
            val (title, text) = alertCopy(attention)
            val notification = NotificationCompat.Builder(context, CHANNEL_ATTENTION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setContentIntent(openApp(context))
                .build()
            context.getSystemService(NotificationManager::class.java).notify(ATTENTION_ID, notification)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SessionService::class.java))
        }

        private fun sanitize(label: String?): String = if (label != null && label in LABELS) label else "Live"

        private fun alertCopy(attention: Attention): Pair<String, String> = when (attention) {
            Attention.HostAway -> "Host away" to "The computer disconnected"
            Attention.RoomClosed -> "Room closed" to "The session ended"
            Attention.AgentFinished -> "Agent finished" to "Ready for a message"
            Attention.NeedsInput -> "Needs input" to "The agent is waiting"
        }

        private fun ongoing(context: Context, label: String): Notification {
            return NotificationCompat.Builder(context, CHANNEL_ONGOING)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("oh-my-pk")
                .setContentText(label)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setContentIntent(openApp(context))
                .build()
        }

        private fun openApp(context: Context): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP,
            )
            return PendingIntent.getActivity(
                context,
                7,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        private fun createChannels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            val ongoing = NotificationChannel(
                CHANNEL_ONGOING,
                "Session",
                NotificationManager.IMPORTANCE_LOW,
            )
            val attention = NotificationChannel(
                CHANNEL_ATTENTION,
                "Attention",
                NotificationManager.IMPORTANCE_DEFAULT,
            )
            manager.createNotificationChannel(ongoing)
            manager.createNotificationChannel(attention)
        }
    }
}
