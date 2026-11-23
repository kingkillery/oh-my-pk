package computer.pkking.ompk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMemoryTest {
    private val link = "test-room.test-secret"

    @Test
    fun isOffUntilRememberIsCalled() {
        val store = MemoryStore()
        assertNull(SessionMemory.read(store))
        assertTrue(SessionMemory.remember(store, "  $link  "))
        assertEquals(
            mapOf(SessionMemory.FLAG_KEY to "1", SessionMemory.LINK_KEY to link),
            store.dump(),
        )
        assertEquals(link, SessionMemory.read(store))
    }

    @Test
    fun ignoresLeftoverLinkWhenFlagIsOff() {
        val store = MemoryStore(mapOf(SessionMemory.LINK_KEY to link))
        assertNull(SessionMemory.read(store))
    }

    @Test
    fun forgetRemovesFlagAndLink() {
        val store = MemoryStore()
        SessionMemory.remember(store, link)
        SessionMemory.forget(store)
        assertNull(SessionMemory.read(store))
        assertEquals(emptyMap<String, String>(), store.dump())
    }

    @Test
    fun rejectsEmptyLinkAndAStoreThatDropsWrites() {
        val store = MemoryStore()
        assertFalse(SessionMemory.remember(store, "   "))
        assertEquals(emptyMap<String, String>(), store.dump())

        val dropped = object : KeyValueStore {
            override fun getItem(key: String): String? = null

            override fun setItem(key: String, value: String) {}

            override fun removeItem(key: String) {}
        }
        assertFalse(SessionMemory.remember(dropped, link))
    }

    @Test
    fun storageFailuresDoNotThrow() {
        val broken = object : KeyValueStore {
            override fun getItem(key: String): String = throw IllegalStateException("blocked")

            override fun setItem(key: String, value: String) = throw IllegalStateException("blocked")

            override fun removeItem(key: String) = throw IllegalStateException("blocked")
        }
        assertNull(SessionMemory.read(broken))
        assertFalse(SessionMemory.remember(broken, link))
        SessionMemory.forget(broken)
    }
}

private class MemoryStore(seed: Map<String, String> = emptyMap()) : KeyValueStore {
    private val map = seed.toMutableMap()

    override fun getItem(key: String): String? = map[key]

    override fun setItem(key: String, value: String) {
        map[key] = value
    }

    override fun removeItem(key: String) {
        map.remove(key)
    }

    fun dump(): Map<String, String> = map.toMap()
}
