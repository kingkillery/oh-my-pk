package computer.pkking.ompk

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CollabLinkTest {
    private val key = ByteArray(32) { it.toByte() }
    private val keyText = CollabLinks.encodeBase64Url(key)
    private val room = "AbCdEf123456_-Xy"

    @Test
    fun parsesBareDotLinkAgainstDefaultRelay() {
        val parsed = ok("$room.$keyText")
        assertEquals("${CollabLinks.DEFAULT_RELAY}/r/$room", parsed.wsUrl)
        assertEquals(room, parsed.roomId)
        assertArrayEquals(key, parsed.key)
        assertNull(parsed.writeToken)
    }

    @Test
    fun parsesLegacyBareHashLink() {
        val parsed = ok("$room#$keyText")
        assertEquals("${CollabLinks.DEFAULT_RELAY}/r/$room", parsed.wsUrl)
        assertArrayEquals(key, parsed.key)
    }

    @Test
    fun infersWssForSchemeLessHosts() {
        val parsed = ok("relay.example.com:8443/r/$room#$keyText")
        assertEquals("wss://relay.example.com:8443/r/$room", parsed.wsUrl)
    }

    @Test
    fun allowsPlainWsForLocalhostOnly() {
        val parsed = ok("ws://localhost:7466/r/$room#$keyText")
        assertEquals("ws://localhost:7466/r/$room", parsed.wsUrl)
        assertTrue(CollabLinks.parse("ws://relay.example.com/r/$room#$keyText") is CollabLinks.LinkParse.Invalid)
    }

    @Test
    fun rejectsKeysThatAreNot32Or48Bytes() {
        val shortKey = CollabLinks.encodeBase64Url(ByteArray(16))
        val midKey = CollabLinks.encodeBase64Url(ByteArray(40))
        assertFalse(CollabLinks.admits("$room#$shortKey"))
        assertFalse(CollabLinks.admits("$room#$midKey"))
    }

    @Test
    fun splitsFullLinkIntoKeyAndWriteToken() {
        val token = ByteArray(16) { (0xf0 + it).toByte() }
        val full = ok(CollabLinks.format(CollabLinks.DEFAULT_RELAY, room, key, token))
        assertArrayEquals(key, full.key)
        assertArrayEquals(token, full.writeToken)
        val view = ok(CollabLinks.format(CollabLinks.DEFAULT_RELAY, room, key))
        assertArrayEquals(key, view.key)
        assertNull(view.writeToken)
    }

    @Test
    fun parsesWebDeepLinks() {
        val bare = ok("https://collab.pkking.computer/#$room#$keyText")
        assertEquals("${CollabLinks.DEFAULT_RELAY}/r/$room", bare.wsUrl)
        val custom = ok("https://relay.example.com:8443/#relay.example.com:8443/r/$room#$keyText")
        assertEquals("wss://relay.example.com:8443/r/$room", custom.wsUrl)
        val local = ok("http://localhost:7466/#ws://localhost:7466/r/$room#$keyText")
        assertEquals("ws://localhost:7466/r/$room", local.wsUrl)
    }

    @Test
    fun parsesThePhoneQrShape() {
        val parsed = ok("https://oh-my-pk.pkking.computer/collab/#$room.$keyText")
        assertEquals("${CollabLinks.DEFAULT_RELAY}/r/$room", parsed.wsUrl)
        assertArrayEquals(key, parsed.key)
    }

    @Test
    fun parsesCustomWebWrapperByFragment() {
        val parsed = ok("http://web.example/collab/#relay.example.com:8443/r/$room.$keyText")
        assertEquals("wss://relay.example.com:8443/r/$room", parsed.wsUrl)
    }

    @Test
    fun parsesFullRelayUrlInFragment() {
        val parsed = ok("https://web.example/collab/#wss://relay.example.com/r/$room.$keyText")
        assertEquals("wss://relay.example.com/r/$room", parsed.wsUrl)
    }

    @Test
    fun invalidHttpFragmentDoesNotBecomeALink() {
        assertTrue(CollabLinks.parse("https://web.example/#not-a-collab-link") is CollabLinks.LinkParse.Invalid)
    }

    @Test
    fun prefersBrowserWrapperFragmentOverRelayLikePath() {
        val inner = CollabLinks.format("wss://relay.example.com", room, key)
        val parsed = ok("https://web.example/r/abcdefghij#$inner")
        assertEquals("wss://relay.example.com/r/$room", parsed.wsUrl)
    }

    @Test
    fun acceptsPercentEncodedLegacyHash() {
        val parsed = ok("https://collab.pkking.computer/#$room%23$keyText")
        assertEquals("${CollabLinks.DEFAULT_RELAY}/r/$room", parsed.wsUrl)
        assertArrayEquals(key, parsed.key)
    }

    @Test
    fun parsesLegacyHttpsDirectRelay() {
        val parsed = ok("https://relay.example.com/r/$room#$keyText")
        assertEquals("wss://relay.example.com/r/$room", parsed.wsUrl)
    }

    @Test
    fun roundTripsFormatAndParse() {
        for (relay in listOf(CollabLinks.DEFAULT_RELAY, "wss://relay.example.com:8443", "ws://127.0.0.1:7466")) {
            val parsed = ok(CollabLinks.format(relay, room, key))
            assertEquals(room, parsed.roomId)
            assertArrayEquals(key, parsed.key)
        }
    }

    @Test
    fun rejectionDoesNotEchoTheInput() {
        val marker = "not-a-session-secret-marker"
        assertFalse(CollabLinks.admits(marker))
        assertFalse(CollabLinks.ADMISSION_ERROR.contains(marker))
        val parsed = CollabLinks.parse("https://oh-my-pk.pkking.computer/collab/#$marker")
        assertTrue(parsed is CollabLinks.LinkParse.Invalid)
        assertFalse(parsed.toString().contains(marker))
    }

    @Test
    fun descriptionOmitsTheKey() {
        val parsed = ok("$room.$keyText")
        assertFalse(parsed.toString().contains(keyText))
    }

    @Test
    fun nestedWrappersStop() {
        var link = "nope"
        repeat(8) {
            link = "https://web.example/collab/#$link"
        }
        assertTrue(CollabLinks.parse(link) is CollabLinks.LinkParse.Invalid)
    }

    private fun ok(link: String): CollabLinks.LinkParse.Ok {
        val parsed = CollabLinks.parse(link)
        assertTrue(parsed is CollabLinks.LinkParse.Ok)
        return parsed as CollabLinks.LinkParse.Ok
    }
}
