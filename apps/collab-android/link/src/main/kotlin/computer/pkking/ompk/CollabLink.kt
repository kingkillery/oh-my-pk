package computer.pkking.ompk

import java.net.URI
import java.net.URISyntaxException
import java.util.Base64

/**
 * Phone-side check for a collab join link.
 *
 * This mirrors `packages/collab-web/src/lib/link.ts`. Error text never includes
 * the input: the link is the room credential.
 */
object CollabLinks {
    const val DEFAULT_RELAY = "wss://collab.pkking.computer"
    const val ADMISSION_ERROR = "Could not open that session"

    private const val KEY_BYTES = 32
    private const val TOKEN_BYTES = 16
    private const val MAX_DEPTH = 6
    private const val MAX_LENGTH = 4096

    private val BARE = Regex("^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$")
    private val ROOM_PATH = Regex("^/r/([A-Za-z0-9_-]{10,64})(?:\\.([A-Za-z0-9_-]+))?$")
    private val B64 = Regex("^[A-Za-z0-9_-]+$")

    sealed interface LinkParse {
        class Ok(
            val wsUrl: String,
            val roomId: String,
            val key: ByteArray,
            val writeToken: ByteArray?,
        ) : LinkParse {
            override fun toString(): String = "Ok"
        }

        data object Invalid : LinkParse
    }

    fun admits(link: String): Boolean {
        val trimmed = link.trim()
        if (trimmed.length > MAX_LENGTH) return false
        return parse(trimmed) is LinkParse.Ok
    }

    fun parse(link: String, depth: Int = 0): LinkParse {
        if (depth > MAX_DEPTH || link.length > MAX_LENGTH) return LinkParse.Invalid
        var text = link.trim().replace(Regex("%23", RegexOption.IGNORE_CASE), "#")
        if (text.length > MAX_LENGTH) return LinkParse.Invalid
        val bare = BARE.matchEntire(text)
        if (bare != null) {
            text = "$DEFAULT_RELAY/r/${bare.groupValues[1]}.${bare.groupValues[2]}"
        } else if (!text.contains("://")) {
            text = "wss://$text"
        }
        val hashAt = text.indexOf('#')
        val before = if (hashAt >= 0) text.substring(0, hashAt) else text
        val fragment = if (hashAt >= 0) text.substring(hashAt + 1) else ""
        val uri = try {
            URI(before)
        } catch (_: URISyntaxException) {
            return LinkParse.Invalid
        }
        val scheme = uri.scheme?.lowercase()
        if ((scheme == "http" || scheme == "https") && fragment.isNotEmpty()) {
            val inner = parse(fragment, depth + 1)
            if (inner is LinkParse.Ok) return inner
        }
        val origin = normalize(uri) ?: return LinkParse.Invalid
        val match = ROOM_PATH.matchEntire(uri.path ?: "")
        if (match == null) {
            if (fragment.isNotEmpty() && scheme != "http" && scheme != "https") {
                return parse(fragment, depth + 1)
            }
            return LinkParse.Invalid
        }
        val roomId = match.groupValues[1]
        val dotted = match.groupValues[2]
        val secretText = if (dotted.isNotEmpty()) dotted else fragment
        if (secretText.isEmpty()) return LinkParse.Invalid
        val secret = decodeBase64Url(secretText) ?: return LinkParse.Invalid
        if (secret.size != KEY_BYTES && secret.size != KEY_BYTES + TOKEN_BYTES) return LinkParse.Invalid
        val key = secret.copyOfRange(0, KEY_BYTES)
        val token = if (secret.size > KEY_BYTES) secret.copyOfRange(KEY_BYTES, secret.size) else null
        return LinkParse.Ok("$origin/r/$roomId", roomId, key, token)
    }

    fun format(relayUrl: String, roomId: String, key: ByteArray, writeToken: ByteArray? = null): String {
        val uri = try {
            URI(relayUrl)
        } catch (_: URISyntaxException) {
            throw IllegalArgumentException("bad relay")
        }
        val origin = normalize(uri) ?: throw IllegalArgumentException("bad relay")
        val secret = if (writeToken == null) key else key + writeToken
        val keyText = encodeBase64Url(secret)
        if (origin == DEFAULT_RELAY) return "$roomId.$keyText"
        val compact = if (origin.startsWith("wss://")) origin.removePrefix("wss://") else origin
        return "$compact/r/$roomId.$keyText"
    }

    fun encodeBase64Url(bytes: ByteArray): String {
        return Base64.getEncoder().encodeToString(bytes).replace('+', '-').replace('/', '_').trimEnd('=')
    }

    private fun decodeBase64Url(text: String): ByteArray? {
        if (!B64.matches(text)) return null
        val base64 = text.replace('-', '+').replace('_', '/')
        val pad = (4 - base64.length % 4) % 4
        val padded = base64 + "=".repeat(pad)
        return try {
            Base64.getDecoder().decode(padded)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun normalize(uri: URI): String? {
        val ws = when (uri.scheme?.lowercase()) {
            "wss", "https" -> "wss"
            "ws", "http" -> "ws"
            else -> return null
        }
        val host = uri.host ?: return null
        if (ws == "ws" && !isLocal(host)) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        val bracketed = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        return "$ws://$bracketed$port"
    }

    private fun isLocal(host: String): Boolean {
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }
}
