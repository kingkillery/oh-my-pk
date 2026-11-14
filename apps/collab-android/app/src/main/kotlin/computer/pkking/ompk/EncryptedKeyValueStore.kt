package computer.pkking.ompk

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Keystore-backed store for the optional remembered session link.
 *
 * Values are AES-256-GCM and keys are AES-256-SIV, with the master key in
 * the Android Keystore. Callers still must not log the strings they pass in.
 */
class EncryptedKeyValueStore(context: Context) : KeyValueStore {
    private val prefs = create(context.applicationContext)

    override fun getItem(key: String): String? = synchronized(prefs) {
        prefs.getString(key, null)
    }

    override fun setItem(key: String, value: String) {
        synchronized(prefs) {
            prefs.edit().putString(key, value).commit()
        }
    }

    override fun removeItem(key: String) {
        synchronized(prefs) {
            prefs.edit().remove(key).commit()
        }
    }

    companion object {
        const val FILE_NAME = "ompk.session"

        @Suppress("DEPRECATION")
        private fun create(context: Context) = EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }
}
