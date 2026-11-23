package computer.pkking.ompk

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen

class MainActivity : ComponentActivity() {
    private val store: KeyValueStore by lazy { openStore() }
    private var previousStatus: SessionStatus? = null
    private var screen by mutableStateOf<Screen>(Screen.Join)
    private var error by mutableStateOf<String?>(null)
    private var saved by mutableStateOf(false)
    private var night by mutableIntStateOf(Configuration.UI_MODE_NIGHT_UNDEFINED)

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.Transparent.toArgb(), Color.Transparent.toArgb()),
            navigationBarStyle = SystemBarStyle.auto(Color.Transparent.toArgb(), Color.Transparent.toArgb()),
        )
        window.decorView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        saved = SessionMemory.read(store) != null
        consumeIntent(intent)
        setContent {
            val dark = night == Configuration.UI_MODE_NIGHT_YES
            OmpkTheme(dark) {
                Surface(Modifier.fillMaxSize(), color = androidx.compose.material3.MaterialTheme.colorScheme.background) {
                    when (val current = screen) {
                        Screen.Join -> JoinScreen(
                            saved = saved,
                            error = error,
                            onScan = { remember -> screen = Screen.Scan(remember) },
                            onJoin = { link, remember -> openLink(link, remember, explicit = true) },
                            onContinue = { continueSaved() },
                            onForget = {
                                SessionMemory.forget(store)
                                saved = false
                                error = null
                            },
                            onDismissError = { error = null },
                        )
                        is Screen.Scan -> ScanScreen(
                            onClose = { screen = Screen.Join },
                            onLink = { raw -> openLink(raw, current.remember, explicit = true) },
                        )
                        is Screen.Session -> SessionPane(
                            url = current.url,
                            dark = dark,
                            onLeave = { leaveSession() },
                            onStatus = { status -> onStatus(status) },
                            onRemember = { link -> rememberFromPage(link) },
                            onForget = { forgetFromPage() },
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        consumeIntent(intent)
        setIntent(Intent(this, javaClass).setAction(Intent.ACTION_MAIN))
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        night = newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK
    }

    override fun onDestroy() {
        if (!isChangingConfigurations) SessionService.stop(this)
        super.onDestroy()
    }

    private fun consumeIntent(incoming: Intent?) {
        if (incoming == null) return
        if (BuildConfig.DEBUG) {
            when (incoming.getStringExtra("screen")) {
                "preview" -> {
                    val theme = incoming.getStringExtra("theme")
                    clearIntent(incoming)
                    openPreview(theme)
                    return
                }
                "join" -> {
                    clearIntent(incoming)
                    screen = Screen.Join
                    return
                }
            }
        }
        val raw = when (incoming.action) {
            Intent.ACTION_SEND -> incoming.getStringExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_VIEW -> incoming.data?.toString()
            else -> null
        }
        clearIntent(incoming)
        if (raw.isNullOrBlank()) return
        openLink(raw, remember = false, explicit = false)
    }

    private fun openLink(raw: String, remember: Boolean, explicit: Boolean) {
        val trimmed = raw.trim()
        if (!CollabLinks.admits(trimmed)) {
            error = CollabLinks.ADMISSION_ERROR
            screen = Screen.Join
            return
        }
        val stored = when {
            remember -> SessionMemory.remember(store, trimmed)
            explicit -> {
                SessionMemory.forget(store)
                false
            }
            else -> false
        }
        error = null
        saved = SessionMemory.read(store) != null
        previousStatus = null
        screen = Screen.Session(AssetUrls.session(trimmed, stored), preview = false)
    }

    private fun continueSaved() {
        val link = SessionMemory.read(store)
        if (link == null) {
            saved = false
            return
        }
        error = null
        previousStatus = null
        screen = Screen.Session(AssetUrls.session(link, remembered = true), preview = false)
    }

    private fun openPreview(theme: String?) {
        error = null
        previousStatus = null
        screen = Screen.Session(AssetUrls.preview(theme), preview = true)
    }

    private fun leaveSession() {
        previousStatus = null
        SessionService.stop(this)
        saved = SessionMemory.read(store) != null
        error = null
        screen = Screen.Join
    }

    private fun onStatus(status: SessionStatus) {
        if (screen !is Screen.Session) return
        val alerts = attentions(previousStatus, status)
        previousStatus = status
        try {
            SessionService.start(this, ongoingLabel(status))
        } catch (_: Exception) {
            return
        }
        for (alert in alerts) SessionService.alert(this, alert)
    }

    private fun rememberFromPage(link: String) {
        if (!CollabLinks.admits(link)) return
        if (SessionMemory.remember(store, link)) saved = true
    }

    private fun forgetFromPage() {
        SessionMemory.forget(store)
        saved = false
    }

    private fun openStore(): KeyValueStore {
        return try {
            EncryptedKeyValueStore(applicationContext)
        } catch (_: Exception) {
            object : KeyValueStore {
                override fun getItem(key: String): String? = null

                override fun setItem(key: String, value: String) {}

                override fun removeItem(key: String) {}
            }
        }
    }

    private fun clearIntent(incoming: Intent) {
        incoming.replaceExtras(null as android.os.Bundle?)
        incoming.data = null
    }
}

private sealed interface Screen {
    data object Join : Screen

    data class Scan(val remember: Boolean) : Screen

    data class Session(val url: String, val preview: Boolean) : Screen {
        override fun toString(): String = if (preview) "Session(preview)" else "Session"
    }
}
