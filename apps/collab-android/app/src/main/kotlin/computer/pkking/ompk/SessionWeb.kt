package computer.pkking.ompk

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.annotation.Keep
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import kotlin.math.roundToInt

class ThemeFlag(var dark: Boolean)

@Keep
class NativeBridge(
    private val main: Handler,
    private val onStatus: (SessionStatus) -> Unit,
    private val onRemember: (String) -> Unit,
    private val onForget: () -> Unit,
    private val onLeave: () -> Unit,
) {
    @JavascriptInterface
    fun postStatus(json: String) {
        val status = parseSessionStatus(json) ?: return
        main.post { onStatus(status) }
    }

    @JavascriptInterface
    fun remember(link: String) {
        if (link.length > 4096) return
        main.post { onRemember(link) }
    }

    @JavascriptInterface
    fun forget() {
        main.post { onForget() }
    }

    @JavascriptInterface
    fun leave() {
        main.post { onLeave() }
    }
}

private const val STATUS_BRIDGE_JS = """
(function(){
  if (window.__ompkStatusBridge) return;
  window.__ompkStatusBridge = true;
  var last = "";
  function tick(){
    var el = document.querySelector(".sh-app");
    if (!el || !window.OmpkNative || typeof window.OmpkNative.postStatus !== "function") return;
    var payload = JSON.stringify({
      connection: el.getAttribute("data-connection") || "",
      working: el.getAttribute("data-working") === "true",
      needsInput: el.getAttribute("data-needs-input") === "true"
    });
    if (payload === last) return;
    last = payload;
    window.OmpkNative.postStatus(payload);
  }
  var obs = new MutationObserver(tick);
  obs.observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:["data-connection","data-working","data-needs-input"]});
  window.__ompkHandleBack = function(){
    var backdrop = document.querySelector(".ag-drawer-backdrop, .ss-drawer-backdrop, .sh-rail-backdrop");
    if (!backdrop) return false;
    backdrop.click();
    return true;
  };
  tick();
  setInterval(tick, 500);
})();
"""

private fun themeScript(dark: Boolean): String {
    val theme = if (dark) "dark" else "light"
    return "(function(){var t='$theme';document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;})();"
}

@SuppressLint("SetJavaScriptEnabled")
private fun buildSessionWebView(
    context: android.content.Context,
    url: String,
    theme: ThemeFlag,
    bridge: NativeBridge,
    onGone: () -> Unit,
): KeepAliveWebView {
    val assetLoader = WebViewAssetLoader.Builder()
        .setDomain(AssetUrls.HOST)
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()
    return KeepAliveWebView(context).apply {
        keepRunning = true
        setBackgroundColor(if (theme.dark) Color.parseColor("#0F0B14") else Color.parseColor("#FAF7FC"))
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        isForceDarkAllowed = false
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.safeBrowsingEnabled = false
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.textZoom = (resources.configuration.fontScale * 100).roundToInt().coerceIn(80, 200)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
        }
        WebView.setWebContentsDebuggingEnabled(false)
        addJavascriptInterface(bridge, "OmpkNative")
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean = true

            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                result?.cancel()
                return true
            }
        }
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                return request.url.host != AssetUrls.HOST
            }

            override fun onPageFinished(view: WebView, finishedUrl: String) {
                val host = Uri.parse(finishedUrl).host
                if (host != AssetUrls.HOST) return
                view.evaluateJavascript(STATUS_BRIDGE_JS, null)
                view.evaluateJavascript(themeScript(theme.dark), null)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                onGone()
                return true
            }
        }
        loadUrl(url)
    }
}

private fun destroySessionWebView(view: WebView) {
    if (view is KeepAliveWebView) view.keepRunning = false
    view.stopLoading()
    view.clearHistory()
    view.removeJavascriptInterface("OmpkNative")
    WebStorage.getInstance().deleteAllData()
    (view.parent as? android.view.ViewGroup)?.removeView(view)
    view.removeAllViews()
    view.destroy()
}

@Composable
fun SessionPane(
    url: String,
    dark: Boolean,
    onLeave: () -> Unit,
    onStatus: (SessionStatus) -> Unit,
    onRemember: (String) -> Unit,
    onForget: () -> Unit,
) {
    val context = LocalContext.current
    val theme = remember(url) { ThemeFlag(dark) }
    theme.dark = dark
    val main = remember { Handler(Looper.getMainLooper()) }
    val bridge = remember(url) { NativeBridge(main, onStatus, onRemember, onForget, onLeave) }
    val viewRef = remember(url) { mutableStateOf<KeepAliveWebView?>(null) }
    val notificationPermission = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { }
    LaunchedEffect(Unit) {
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    DisposableEffect(url) {
        try {
            SessionService.start(context, "Connecting")
        } catch (_: Exception) {
            // The page still runs while this activity is in front.
        }
        onDispose { SessionService.stop(context) }
    }
    Box(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.ime).union(WindowInsets.displayCutout)),
    ) {
        key(url) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = {
                    buildSessionWebView(context, url, theme, bridge) { main.post { onLeave() } }.also {
                        viewRef.value = it
                    }
                },
                onRelease = { view ->
                    viewRef.value = null
                    destroySessionWebView(view)
                },
            )
        }
    }
    LaunchedEffect(dark, viewRef.value) {
        viewRef.value?.evaluateJavascript(themeScript(dark), null)
        viewRef.value?.setBackgroundColor(if (dark) Color.parseColor("#0F0B14") else Color.parseColor("#FAF7FC"))
    }
    BackHandler {
        val view = viewRef.value
        if (view == null) {
            onLeave()
            return@BackHandler
        }
        view.evaluateJavascript("window.__ompkHandleBack ? window.__ompkHandleBack() : false") { result ->
            if (result != "true") onLeave()
        }
    }
}
