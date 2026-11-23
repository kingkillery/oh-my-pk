package computer.pkking.ompk

/**
 * Local notification decisions from the session flags the page already exposes.
 *
 * The first snapshot does not say "finished": opening an idle session is not
 * the agent stopping. A host that is already away, a closed room, or an agent
 * already waiting on ask/resolve does notify, because those states are the event.
 */
data class SessionStatus(
    val connection: String,
    val working: Boolean,
    val needsInput: Boolean,
)

enum class Attention {
    HostAway,
    RoomClosed,
    AgentFinished,
    NeedsInput,
}

private val CONNECTIONS = setOf(
    "",
    "connecting",
    "joining",
    "live",
    "host-away",
    "reconnecting",
    "room-closed",
    "ended",
)

private val CONNECTION_FIELD = Regex(""""connection"\s*:\s*"([a-z-]*)"""")
private val WORKING_FIELD = Regex(""""working"\s*:\s*(true|false)""")
private val NEEDS_FIELD = Regex(""""needsInput"\s*:\s*(true|false)""")

fun attentions(previous: SessionStatus?, next: SessionStatus): List<Attention> {
    if (previous == null) {
        val first = ArrayList<Attention>(2)
        if (next.connection == "host-away") first.add(Attention.HostAway)
        if (next.connection == "room-closed") first.add(Attention.RoomClosed)
        if (next.needsInput) first.add(Attention.NeedsInput)
        return first
    }
    val out = ArrayList<Attention>(3)
    if (previous.connection != "host-away" && next.connection == "host-away") out.add(Attention.HostAway)
    if (previous.connection != "room-closed" && next.connection == "room-closed") out.add(Attention.RoomClosed)
    if (!previous.needsInput && next.needsInput) out.add(Attention.NeedsInput)
    if (previous.working && !next.working && !next.needsInput && next.connection == "live") {
        out.add(Attention.AgentFinished)
    }
    return out
}

fun ongoingLabel(status: SessionStatus): String = when {
    status.needsInput -> "Needs input"
    status.working && status.connection == "live" -> "Working"
    status.connection == "host-away" -> "Host away"
    status.connection == "room-closed" -> "Room closed"
    status.connection == "reconnecting" -> "Reconnecting"
    status.connection == "connecting" || status.connection == "joining" -> "Connecting"
    status.connection == "ended" -> "Ended"
    status.working -> "Working"
    else -> "Live"
}

/** Accepts only the bridge payload. Anything else, including a link, is dropped. */
fun parseSessionStatus(json: String): SessionStatus? {
    if (json.length > 256) return null
    val connection = CONNECTION_FIELD.find(json)?.groupValues?.get(1) ?: return null
    if (connection !in CONNECTIONS) return null
    val working = WORKING_FIELD.find(json)?.groupValues?.get(1) ?: return null
    val needsInput = NEEDS_FIELD.find(json)?.groupValues?.get(1) ?: return null
    return SessionStatus(
        connection = connection,
        working = working == "true",
        needsInput = needsInput == "true",
    )
}
