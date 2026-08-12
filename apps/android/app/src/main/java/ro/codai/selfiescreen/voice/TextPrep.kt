package ro.codai.selfiescreen.voice

import ro.codai.selfiescreen.ChatMessage

/** Cleans chat text for speech: strips emoji/URLs/spam, expands common slang. */
object TextPrep {

    private val urlRegex = Regex("""https?://\S+|www\.\S+""")
    private val emojiRegex = Regex(
        "[\\p{So}\\p{Cn}\\uFE0F\\u200D]+"
    )
    private val repeatCharRegex = Regex("(.)\\1{3,}")
    private val whitespaceRegex = Regex("\\s+")
    private val mentionRegex = Regex("""@(\w+)""")

    /** Words that make a message pure noise — never worth speaking. */
    private val noise = setOf(
        "hi", "hii", "hello", "yo", "ok", "okk", "k", "lol", "lmao",
        "salut", "buna", "bună", "ok.", "👍", "❤", "🔥",
    )

    private val profanity = listOf(
        // kept short + generic; extend from settings blocklist
        "fuck", "shit", "bitch", "cunt", "nigg", "retard", "rape",
        "pula", "pizda", "muie", "curva", "futu",
    )

    /** Latin transliteration hints so voices pronounce RO names sensibly. */
    private val pronunciation = mapOf(
        "ă" to "a", "â" to "a", "î" to "i", "ș" to "sh", "ț" to "ts",
    )

    data class Prepared(val speakText: String, val skipped: String? = null)

    fun prepare(
        msg: ChatMessage,
        readUsernames: Boolean,
        moderation: Boolean,
        blockedWords: Set<String> = emptySet(),
    ): Prepared {
        var text = msg.text
        text = urlRegex.replace(text, " ")
        text = mentionRegex.replace(text) { it.groupValues[1] }
        text = emojiRegex.replace(text, " ")
        text = repeatCharRegex.replace(text) { it.groupValues[1].repeat(2) }
        text = whitespaceRegex.replace(text, " ").trim()

        if (text.isBlank()) return Prepared("", skipped = "empty after cleanup")
        if (text.length > 200) text = text.take(197) + "…"

        val lower = text.lowercase()
        if (msg.kind == ChatMessage.Kind.CHAT && lower in noise) {
            return Prepared("", skipped = "noise")
        }
        if (moderation) {
            val hit = profanity.firstOrNull { lower.contains(it) }
                ?: blockedWords.firstOrNull { it.isNotBlank() && lower.contains(it.lowercase()) }
            if (hit != null) return Prepared("", skipped = "moderation:$hit")
        }

        val name = speakableName(msg.user)
        val body = when (msg.kind) {
            ChatMessage.Kind.CHAT -> if (readUsernames) "$name says: $text" else text
            ChatMessage.Kind.GIFT -> "$name $text"
            ChatMessage.Kind.FOLLOW -> "$name just followed"
            ChatMessage.Kind.SHARE -> "$name shared the live"
            ChatMessage.Kind.JOIN -> "$name joined"
            ChatMessage.Kind.LIKE -> "$name $text"
        }
        return Prepared(body)
    }

    /** Makes a username pronounceable: strips decorations, expands separators. */
    fun speakableName(raw: String): String {
        var n = raw
        n = emojiRegex.replace(n, "")
        n = n.replace(Regex("[._\\-]+"), " ")
        n = n.replace(Regex("\\d{3,}"), "") // drop long digit runs (user1234567)
        n = whitespaceRegex.replace(n, " ").trim()
        pronunciation.forEach { (from, to) -> n = n.replace(from, to).replace(from.uppercase(), to) }
        if (n.isBlank()) n = "someone"
        return n.take(28)
    }
}
