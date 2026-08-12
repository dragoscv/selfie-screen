package ro.codai.selfiescreen.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PictureInPicture
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.voice.VoiceSettings

class VoiceSettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val settings = VoiceSettings(applicationContext)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(primary = Accent, background = Bg, surface = CardBg)
            ) {
                SettingsScreen(settings, onBack = { onBackPressedDispatcher.onBackPressed() })
            }
        }
    }
}

private enum class Tab(val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Voice("Voice", Icons.Filled.RecordVoiceOver),
    Filters("Read aloud", Icons.Filled.Mic),
    Assistant("AI co-host", Icons.Filled.SmartToy),
    Display("Display", Icons.Filled.PictureInPicture),
    Memory("Memory", Icons.Filled.Person),
}

@Composable
private fun SettingsScreen(settings: VoiceSettings, onBack: () -> Unit) {
    val cfg by settings.config.collectAsState(initial = ro.codai.selfiescreen.voice.VoiceConfig())
    val scope = rememberCoroutineScope()
    var tab by remember { mutableIntStateOf(0) }

    // Non-first tab: back returns to the first tab. First tab: leave the screen.
    BackHandler(enabled = tab != 0) { tab = 0 }

    Surface(Modifier.fillMaxSize(), color = Bg) {
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            // Header
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(
                    onClick = onBack,
                    modifier = Modifier.size(44.dp).background(CardBg, CircleShape),
                ) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color_White)
                }
                Spacer(Modifier.width(14.dp))
                Column {
                    Text("Voice & AI Co-Host", color = Color_White, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                    Text("Azure AI Foundry realtime voice", color = TextDim, fontSize = 12.sp)
                }
            }

            // Tabs
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Tab.entries.forEachIndexed { i, t ->
                    val selected = tab == i
                    Column(
                        Modifier
                            .weight(1f)
                            .clickable { tab = i }
                            .background(
                                if (selected) Accent.copy(alpha = 0.16f) else CardBg,
                                RoundedCornerShape(14.dp)
                            )
                            .padding(vertical = 12.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Icon(t.icon, null, tint = if (selected) Accent else TextDim, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.height(4.dp))
                        Text(t.label, color = if (selected) Accent else TextDim, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }

            Spacer(Modifier.height(8.dp))

            AnimatedContent(
                targetState = tab,
                transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(120)) },
                label = "tab"
            ) { t ->
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    when (Tab.entries[t]) {
                        Tab.Voice -> voiceTabItems(cfg, settings, scope)
                        Tab.Filters -> filterTabItems(cfg, settings, scope)
                        Tab.Assistant -> assistantTabItems(cfg, settings, scope)
                        Tab.Display -> displayTabItems(cfg, settings, scope)
                        Tab.Memory -> memoryTabItems()
                    }
                }
            }
        }
    }
}

private val Color_White = androidx.compose.ui.graphics.Color.White
