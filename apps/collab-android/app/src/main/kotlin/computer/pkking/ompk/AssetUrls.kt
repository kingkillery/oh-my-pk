package computer.pkking.ompk

object AssetUrls {
    const val HOST = "appassets.androidplatform.net"
    private const val PAGE = "https://appassets.androidplatform.net/assets/index.html"

    fun session(link: String, remembered: Boolean): String {
        val flag = if (remembered) "1" else "0"
        return "$PAGE?shell=android&remembered=$flag#$link"
    }

    fun preview(theme: String?): String {
        val themeQuery = if (theme == "light" || theme == "dark") "&theme=$theme" else ""
        return "$PAGE?preview=live$themeQuery"
    }
}
