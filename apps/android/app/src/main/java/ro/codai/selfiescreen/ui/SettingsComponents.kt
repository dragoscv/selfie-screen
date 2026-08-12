package ro.codai.selfiescreen.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Section card with a title and optional icon. */
@Composable
fun SettingsCard(
    title: String,
    subtitle: String? = null,
    icon: ImageVector? = null,
    accent: Color = Accent,
    content: @Composable () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(CardBg, RoundedCornerShape(20.dp))
            .padding(18.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) {
                Box(
                    Modifier.size(32.dp).background(accent.copy(alpha = 0.14f), RoundedCornerShape(10.dp)),
                    contentAlignment = Alignment.Center
                ) { Icon(icon, null, tint = accent, modifier = Modifier.size(17.dp)) }
                Spacer(Modifier.width(12.dp))
            }
            Column {
                Text(title, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                if (subtitle != null) Text(subtitle, color = TextDim, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(14.dp))
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            content()
        }
    }
}

/** Animated labeled switch row. */
@Composable
fun SwitchRow(
    label: String,
    description: String? = null,
    checked: Boolean,
    accent: Color = Accent,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled) { onChange(!checked) },
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                label,
                color = if (enabled) Color.White else TextDim,
                fontSize = 14.sp
            )
            if (description != null) Text(description, color = TextDim, fontSize = 11.sp)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = accent,
                uncheckedThumbColor = TextDim,
                uncheckedTrackColor = CardBgAlt,
                uncheckedBorderColor = Color.Transparent,
            )
        )
    }
}

/** Slider with a live value chip. */
@Composable
fun SliderRow(
    label: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    accent: Color = Accent,
    format: (Float) -> String = { "%.2f".format(it) },
    steps: Int = 0,
    onCommit: (Float) -> Unit,
) {
    var local by remember(value) { mutableFloatStateOf(value) }
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = TextMid, fontSize = 13.sp, modifier = Modifier.weight(1f))
            val chipColor by animateColorAsState(accent, tween(200), label = "chip")
            Text(
                format(local),
                color = chipColor,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(chipColor.copy(alpha = 0.14f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 4.dp)
            )
        }
        Slider(
            value = local,
            onValueChange = { local = it },
            onValueChangeFinished = { onCommit(local) },
            valueRange = range,
            steps = steps,
            colors = SliderDefaults.colors(
                thumbColor = accent,
                activeTrackColor = accent,
                inactiveTrackColor = CardBgAlt,
            )
        )
    }
}

/** Horizontal chip selector. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun ChipSelector(
    label: String,
    options: List<String>,
    selected: String,
    accent: Color = Accent,
    display: (String) -> String = { it },
    onSelect: (String) -> Unit,
) {
    Column {
        Text(label, color = TextMid, fontSize = 13.sp)
        Spacer(Modifier.height(8.dp))
        androidx.compose.foundation.layout.FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            options.forEach { opt ->
                val isSel = opt == selected
                val scale by animateFloatAsState(if (isSel) 1f else 0.97f, tween(160), label = "chip")
                Box(
                    Modifier
                        .background(
                            if (isSel) accent.copy(alpha = 0.18f) else CardBgAlt,
                            RoundedCornerShape(12.dp)
                        )
                        .then(
                            if (isSel) Modifier.border(1.dp, accent.copy(alpha = 0.55f), RoundedCornerShape(12.dp))
                            else Modifier
                        )
                        .clickable { onSelect(opt) }
                        .padding(horizontal = 14.dp, vertical = 9.dp)
                ) {
                    Text(
                        display(opt),
                        color = if (isSel) accent else TextDim,
                        fontSize = 12.sp,
                        fontWeight = if (isSel) FontWeight.Bold else FontWeight.Normal
                    )
                }
            }
        }
    }
}

/** Multiline text input styled for the dark theme. */
@Composable
fun TextInput(
    label: String,
    value: String,
    placeholder: String = "",
    singleLine: Boolean = true,
    isSecret: Boolean = false,
    onCommit: (String) -> Unit,
) {
    var local by remember(value) { mutableStateOf(value) }
    Column {
        Text(label, color = TextMid, fontSize = 13.sp)
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = local,
            onValueChange = { local = it; onCommit(it) },
            placeholder = { Text(placeholder, color = TextDim, fontSize = 13.sp) },
            singleLine = singleLine,
            minLines = if (singleLine) 1 else 3,
            visualTransformation = if (isSecret)
                androidx.compose.ui.text.input.PasswordVisualTransformation()
            else androidx.compose.ui.text.input.VisualTransformation.None,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Accent,
                unfocusedBorderColor = TextDim.copy(alpha = 0.35f),
                focusedTextColor = Color.White,
                unfocusedTextColor = Color.White,
                focusedContainerColor = CardBgAlt,
                unfocusedContainerColor = CardBgAlt,
            ),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth()
        )
    }
}

/** Reveals content with a smooth expand when [visible]. */
@Composable
fun Reveal(visible: Boolean, content: @Composable () -> Unit) {
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(tween(200)) + expandVertically(tween(220)),
        exit = fadeOut(tween(120)) + shrinkVertically(tween(180)),
    ) { content() }
}

/** Small status pill. */
@Composable
fun StatusPill(text: String, color: Color) {
    Row(
        Modifier
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(20.dp))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(text, color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}
