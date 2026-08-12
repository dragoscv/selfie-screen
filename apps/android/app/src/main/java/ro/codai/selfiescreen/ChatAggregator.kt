package ro.codai.selfiescreen

/**
 * Collapses repetitive events so the feed stays readable.
 *
 * Joins/likes are high-volume and low-information: instead of one row each,
 * they are folded into a single ticker line ("Ana, Mihai +6 joined"). Optional
 * same-user merging keeps a chatty viewer from filling the whole panel.
 */
object ChatAggregator {

    /** A ticker summarising collapsed events of one kind. */
    data class Ticker(
        val kind: ChatMessage.Kind,
        val names: List<String>,
        val total: Int,
    ) {
        /** "Ana, Mihai +6 joined" */
        fun label(verb: String): String {
            val shown = names.take(2).joinToString(", ")
            val extra = total - minOf(names.size, 2)
            return buildString {
                append(shown.ifBlank { "$total people" })
                if (extra > 0) append(" +$extra")
                append(" $verb")
            }
        }
    }

    data class Result(
        val messages: List<ChatMessage>,
        val joinTicker: Ticker?,
        val likeTicker: Ticker?,
    )

    /**
     * @param collapseJoins fold JOIN events into [Result.joinTicker]
     * @param collapseLikes fold LIKE events into [Result.likeTicker]
     * @param mergeSameUser keep only the newest message per consecutive user run
     */
    fun aggregate(
        input: List<ChatMessage>,
        collapseJoins: Boolean,
        collapseLikes: Boolean,
        mergeSameUser: Boolean,
    ): Result {
        val kept = ArrayList<ChatMessage>(input.size)
        val joinNames = LinkedHashSet<String>()
        val likeNames = LinkedHashSet<String>()
        var joinTotal = 0
        var likeTotal = 0

        for (m in input) {
            when {
                collapseJoins && m.kind == ChatMessage.Kind.JOIN -> {
                    joinNames.add(m.user); joinTotal++
                }
                collapseLikes && m.kind == ChatMessage.Kind.LIKE -> {
                    likeNames.add(m.user); likeTotal++
                }
                else -> kept.add(m)
            }
        }

        val merged = if (mergeSameUser) mergeConsecutive(kept) else kept

        return Result(
            messages = merged,
            joinTicker = if (joinTotal > 0)
                Ticker(ChatMessage.Kind.JOIN, joinNames.toList().takeLast(3).reversed(), joinNames.size)
            else null,
            likeTicker = if (likeTotal > 0)
                Ticker(ChatMessage.Kind.LIKE, likeNames.toList().takeLast(3).reversed(), likeNames.size)
            else null,
        )
    }

    /**
     * Fold runs of consecutive messages from the same user+kind into one row,
     * joining their texts (newest last) so nothing is silently lost.
     */
    private fun mergeConsecutive(list: List<ChatMessage>): List<ChatMessage> {
        if (list.size < 2) return list
        val out = ArrayList<ChatMessage>(list.size)
        for (m in list) {
            val prev = out.lastOrNull()
            if (prev != null && prev.user == m.user && prev.kind == m.kind &&
                m.kind == ChatMessage.Kind.CHAT && m.at - prev.at < 30_000
            ) {
                out[out.lastIndex] = prev.copy(
                    text = "${prev.text} · ${m.text}".take(220),
                    at = m.at,
                )
            } else {
                out.add(m)
            }
        }
        return out
    }
}
