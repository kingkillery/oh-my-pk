package computer.pkking.ompk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionAlertsTest {
    @Test
    fun openingAnIdleSessionDoesNotSayFinished() {
        val first = SessionStatus("live", working = false, needsInput = false)
        assertEquals(emptyList<Attention>(), attentions(null, first))
        assertEquals("Live", ongoingLabel(first))
    }

    @Test
    fun openingOntoHostAwayOrAQuestionNotifies() {
        assertEquals(listOf(Attention.HostAway), attentions(null, SessionStatus("host-away", false, false)))
        assertEquals(listOf(Attention.NeedsInput), attentions(null, SessionStatus("live", true, true)))
        assertEquals(listOf(Attention.RoomClosed), attentions(null, SessionStatus("room-closed", false, false)))
    }

    @Test
    fun agentStoppingWhileLiveNotifiesOnce() {
        val working = SessionStatus("live", working = true, needsInput = false)
        val idle = working.copy(working = false)
        assertEquals(listOf(Attention.AgentFinished), attentions(working, idle))
        assertEquals(emptyList<Attention>(), attentions(idle, idle))
        assertEquals("Live", ongoingLabel(idle))
        assertEquals("Working", ongoingLabel(working))
    }

    @Test
    fun needsInputSuppressesTheFinishedAlert() {
        val working = SessionStatus("live", working = true, needsInput = false)
        val waiting = SessionStatus("live", working = false, needsInput = true)
        assertEquals(listOf(Attention.NeedsInput), attentions(working, waiting))
        assertEquals("Needs input", ongoingLabel(waiting))
    }

    @Test
    fun hostAwayDoesNotRepeat() {
        val away = SessionStatus("host-away", working = false, needsInput = false)
        val live = SessionStatus("live", working = true, needsInput = false)
        assertEquals(listOf(Attention.HostAway), attentions(live, away))
        assertEquals(emptyList<Attention>(), attentions(away, away))
        assertEquals("Host away", ongoingLabel(away))
    }

    @Test
    fun statusParserAcceptsOnlyTheBridgeShape() {
        val parsed = parseSessionStatus("""{"connection":"live","working":true,"needsInput":false}""")
        assertEquals(SessionStatus("live", true, false), parsed)
        assertNull(parseSessionStatus("""{"connection":"https://example.invalid/secret","working":false,"needsInput":false}"""))
        assertNull(parseSessionStatus("not json"))
        assertNull(parseSessionStatus("""{"connection":"live"}"""))
        assertTrue((parseSessionStatus("x".repeat(300)) == null))
    }
}
