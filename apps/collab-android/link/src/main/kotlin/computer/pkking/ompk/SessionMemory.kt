package computer.pkking.ompk

/**
 * Optional "remember this session", off until [remember] succeeds.
 *
 * Same contract as `packages/collab-web/src/lib/remember-link.ts`. The Android
 * app supplies a keystore-backed [KeyValueStore]; this object never encrypts
 * or logs the value itself.
 */
interface KeyValueStore {
    fun getItem(key: String): String?

    fun setItem(key: String, value: String)

    fun removeItem(key: String)
}

object SessionMemory {
    const val FLAG_KEY = "omp.collab.remember"
    const val LINK_KEY = "omp.collab.link"

    fun read(store: KeyValueStore): String? {
        return try {
            if (store.getItem(FLAG_KEY) != "1") return null
            val link = store.getItem(LINK_KEY) ?: return null
            val trimmed = link.trim()
            if (trimmed.isEmpty()) null else trimmed
        } catch (_: Exception) {
            null
        }
    }

    fun remember(store: KeyValueStore, link: String): Boolean {
        val trimmed = link.trim()
        if (trimmed.isEmpty()) return false
        return try {
            store.setItem(FLAG_KEY, "1")
            store.setItem(LINK_KEY, trimmed)
            store.getItem(FLAG_KEY) == "1" && store.getItem(LINK_KEY) == trimmed
        } catch (_: Exception) {
            false
        }
    }

    fun forget(store: KeyValueStore) {
        try {
            store.removeItem(FLAG_KEY)
            store.removeItem(LINK_KEY)
        } catch (_: Exception) {
            // already gone
        }
    }
}
