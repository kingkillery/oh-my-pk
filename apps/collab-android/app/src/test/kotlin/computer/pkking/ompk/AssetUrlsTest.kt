package computer.pkking.ompk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AssetUrlsTest {
    @Test
    fun previewCarriesNoFragment() {
        val url = AssetUrls.preview("dark")
        assertTrue(url.startsWith("https://appassets.androidplatform.net/assets/index.html?"))
        assertTrue(url.contains("preview=live"))
        assertTrue(url.contains("theme=dark"))
        assertFalse(url.contains("#"))
    }

    @Test
    fun sessionStaysOnTheAssetOrigin() {
        val url = AssetUrls.session("room.secret", remembered = false)
        assertTrue(url.startsWith("https://${AssetUrls.HOST}/assets/index.html?shell=android&remembered=0#"))
        assertTrue(url.endsWith("#room.secret"))
    }
}
