package ro.codai.selfiescreen.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.MonetizationOn
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.collectAsState
import kotlinx.coroutines.launch
import ro.codai.selfiescreen.MirrorService
import ro.codai.selfiescreen.voice.MemoryDb
import ro.codai.selfiescreen.voice.Person

fun LazyListScope.memoryTabItems() {
    item { MemoryContent() }
}

@Composable
private fun MemoryContent() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var people by remember { mutableStateOf<List<Person>>(emptyList()) }

    LaunchedEffect(Unit) {
        people = MemoryDb.get(context).dao().topPeople(50)
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        SettingsCard(
            "Remembered viewers", "${people.size} people across all your lives",
            icon = Icons.Filled.Groups, accent = Ok,
        ) {
            if (people.isEmpty()) {
                Text("No one remembered yet \u2014 go live!", color = TextDim, fontSize = 13.sp)
            } else {
                people.take(12).forEach { p -> PersonRow(p) }
            }
        }

        SettingsCard(
            "Session", "Cost meter + transcript",
            icon = Icons.Filled.MonetizationOn, accent = AccentWarm,
        ) {
            val assistant = MirrorService.assistant
            val usageFlow = remember(assistant) {
                assistant?.usage ?: kotlinx.coroutines.flow.MutableStateFlow(ro.codai.selfiescreen.voice.UsageTotals())
            }
            val statsFlow = remember(assistant) {
                assistant?.stats ?: kotlinx.coroutines.flow.MutableStateFlow(ro.codai.selfiescreen.voice.AssistantStats())
            }
            val usage by usageFlow.collectAsStateSafe()
            val stats by statsFlow.collectAsStateSafe()

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                StatChip("Spoken", stats.spoken.toString(), Ok)
                StatChip("Queued", stats.queued.toString(), AccentWarm)
                StatChip("Viewers", stats.uniqueViewers.toString(), Accent)
                StatChip("Gifts", stats.giftsSeen.toString(), Violet)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                "Estimated Azure cost: $${"%.4f".format(usage.estimatedUsd)}",
                color = TextMid, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
            )
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(CardBgAlt, RoundedCornerShape(12.dp))
                    .clickable {
                        scope.launch {
                            val text = assistant?.exportTranscript() ?: "No active session."
                            val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(android.content.Intent.EXTRA_TEXT, text)
                            }
                            context.startActivity(android.content.Intent.createChooser(send, "Share transcript"))
                        }
                    }
                    .padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Save, null, tint = AccentWarm, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text("Export & share transcript", color = AccentWarm, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun PersonRow(p: Person) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(30.dp).background(Accent.copy(alpha = 0.16f), CircleShape),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(p.displayName, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Text(
                "${p.liveCount} lives \u00b7 ${p.messageCount} msgs" + if (p.giftCount > 0) " \u00b7 ${p.giftCount} gifts" else "",
                color = TextDim, fontSize = 11.sp,
            )
        }
    }
}

@Composable
private fun StatChip(label: String, value: String, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = color, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text(label, color = TextDim, fontSize = 10.sp)
    }
}

// Small helper so this file doesn't need a ViewModel for a settings screen.
@Composable
private fun <T> kotlinx.coroutines.flow.StateFlow<T>.collectAsStateSafe():
    androidx.compose.runtime.State<T> = this.collectAsState()
