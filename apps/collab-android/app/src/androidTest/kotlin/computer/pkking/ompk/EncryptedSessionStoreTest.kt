package computer.pkking.ompk

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The stored bytes are ciphertext. The fixture is an all-zero key, not a session.
 */
@RunWith(AndroidJUnit4::class)
class EncryptedSessionStoreTest {
    @Test
    fun roundTripDoesNotWriteTheLinkInPlaintext() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val store = EncryptedKeyValueStore(context)
        val link = "AbCdEf123456_-Xy.${CollabLinks.encodeBase64Url(ByteArray(32))}"
        SessionMemory.forget(store)
        assertNull(SessionMemory.read(store))
        assertEquals(true, SessionMemory.remember(store, link))
        assertEquals(link, SessionMemory.read(store))

        val prefs = File(context.applicationInfo.dataDir, "shared_prefs")
        val xml = prefs.listFiles()?.joinToString("\n") { it.readText() }.orEmpty()
        assertFalse(xml.contains(link))
        assertFalse(xml.contains(SessionMemory.LINK_KEY))

        SessionMemory.forget(store)
        assertNull(SessionMemory.read(store))
    }
}
