package computer.pkking.ompk

import android.content.Context
import android.webkit.WebView

/**
 * Keeps the page's timers and socket running when the screen turns off.
 *
 * WebView pauses itself from [onWindowVisibilityChanged] when the window is
 * no longer visible. Reporting the window as visible, together with the
 * foreground service's partial wake lock, is what holds the session open.
 */
class KeepAliveWebView(context: Context) : WebView(context) {
    var keepRunning: Boolean = false

    override fun onWindowVisibilityChanged(visibility: Int) {
        if (keepRunning && visibility != VISIBLE) {
            super.onWindowVisibilityChanged(VISIBLE)
            return
        }
        super.onWindowVisibilityChanged(visibility)
    }

    override fun onPause() {
        if (keepRunning) return
        super.onPause()
    }
}
