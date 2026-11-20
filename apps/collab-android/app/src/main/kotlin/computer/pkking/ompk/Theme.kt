package computer.pkking.ompk

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val DarkColors = darkColorScheme(
    background = Color(0xFF0F0B14),
    surface = Color(0xFF0F0B14),
    primary = Color(0xFFED4ABF),
    onPrimary = Color(0xFF2A0A22),
    onBackground = Color(0xFFECE8F0),
    onSurface = Color(0xFFECE8F0),
    outline = Color(0x26FFFFFF),
    error = Color(0xFFE15A4A),
)

private val LightColors = lightColorScheme(
    background = Color(0xFFFAF7FC),
    surface = Color(0xFFFAF7FC),
    primary = Color(0xFFED4ABF),
    onPrimary = Color(0xFF2A0A22),
    onBackground = Color(0xFF2C2433),
    onSurface = Color(0xFF2C2433),
    outline = Color(0x1A000000),
    error = Color(0xFFB3261E),
)

@Composable
fun OmpkTheme(dark: Boolean, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (dark) DarkColors else LightColors,
        typography = androidx.compose.material3.Typography(
            headlineSmall = TextStyle(
                fontSize = 22.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = (-0.2).sp,
            ),
            bodyLarge = TextStyle(fontSize = 16.sp),
            labelLarge = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium),
        ),
        content = content,
    )
}
