package computer.pkking.ompk

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

@Composable
fun JoinScreen(
    saved: Boolean,
    error: String?,
    onScan: (remember: Boolean) -> Unit,
    onJoin: (link: String, remember: Boolean) -> Unit,
    onContinue: () -> Unit,
    onForget: () -> Unit,
    onDismissError: () -> Unit,
) {
    var editing by remember { mutableStateOf(!saved) }
    var link by remember { mutableStateOf("") }
    var remember by remember { mutableStateOf(false) }
    LaunchedEffect(saved) {
        if (!saved) editing = true
    }
    LaunchedEffect(error) {
        if (error != null) editing = true
    }
    if (saved && !editing) {
        ChoiceList(
            primary = "Continue",
            onPrimary = onContinue,
            secondary = "Forget",
            onSecondary = onForget,
            tertiary = "New session",
            onTertiary = {
                link = ""
                remember = false
                onDismissError()
                editing = true
            },
        )
        return
    }
    if (saved) {
        BackHandler {
            editing = false
            onDismissError()
        }
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.ime).union(WindowInsets.displayCutout))
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Session", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        PrimaryButton("Scan") { onScan(remember) }
        OutlinedTextField(
            value = link,
            onValueChange = {
                link = it
                onDismissError()
            },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Link") },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onJoin(link, remember) }),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = remember, onCheckedChange = { remember = it })
            Text("Remember on this device", style = MaterialTheme.typography.bodyLarge)
        }
        PrimaryButton("Join", enabled = link.isNotBlank()) { onJoin(link, remember) }
        if (error != null) {
            Text(
                error,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

@Composable
private fun ChoiceList(
    primary: String,
    onPrimary: () -> Unit,
    secondary: String,
    onSecondary: () -> Unit,
    tertiary: String,
    onTertiary: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))
            .padding(horizontal = 24.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Session", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        PrimaryButton(primary, onClick = onPrimary)
        TextButton(onClick = onSecondary, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Text(secondary)
        }
        OutlinedButton(onClick = onTertiary, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Text(tertiary)
        }
    }
}

@Composable
private fun PrimaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().height(48.dp),
    ) {
        Text(text)
    }
}
