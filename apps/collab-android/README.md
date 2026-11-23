# oh-my-pk phone remote

Android shell around the collab web client. One UI, one protocol. The APK bundles `packages/collab-web` and loads it from `https://appassets.androidplatform.net`, which is a secure origin, so `crypto.subtle` works. The page still talks only to the relay. Nothing here changes the live site, DNS, or the relay.

A Trusted Web Activity would need Digital Asset Links on `oh-my-pk.pkking.computer`. That file is not part of this app. Capacitor would still need this same native service to keep the socket up with the screen off, plus a second toolchain.

## Build

```sh
export ANDROID_HOME=...   # platform android-37.0, build-tools 36.0.0
bun install --frozen-lockfile
bash apps/collab-android/scripts/build-apk.sh
```

The script runs the JVM unit tests and `assembleDebug`. Debug signing uses the local debug keystore Gradle creates. No keystore is committed. The debug signature differs per machine; the sources and tool versions do not.

`minSdk` is 35 (Android 15). `targetSdk` and `compileSdk` are 37.

## Install

```sh
adb install -r apps/collab-android/app/build/outputs/apk/debug/app-debug.apk
```

## Opening a session

The first screen scans the `/remote-control` QR or takes a pasted link. Remember is off until it is checked. The link is checked before the page loads, and a rejected link is not shown again.

Tapping `https://oh-my-pk.pkking.computer/collab/...` does not open the app by itself on Android 12 and newer. Verified App Links need `/.well-known/assetlinks.json` on that host, and this repo does not deploy that. The filter is registered, so the link opens here after **Open supported links** is turned on for this app. Sharing the link to the app works without that setting. If the view intent arrives without the URL fragment, the join screen stays up: the fragment is the credential, and Android often strips it.

## While a session is open

A foreground service with an ongoing notification holds a partial wake lock, and the WebView keeps running when the screen is off. Leaving the session stops both. The notification text is a fixed status word.

Host away, room closed, the agent finishing, and an in-progress `ask` or `resolve` tool raise a local notification. Those are read from the page's existing snapshot. There is no server push and no relay change.

## Remember

The checkbox and the in-session Remember control write the link through EncryptedSharedPreferences (keystore AES-256-GCM). Backups exclude app data. The page does not copy the link into WebView localStorage in this shell. Safe Browsing is off so the fragment is not sent out for a URL check. The activity does not put the link in saved instance state.

Screenshot previews use `?preview=live` on the asset origin. That path is a zero key and is not dialed.
