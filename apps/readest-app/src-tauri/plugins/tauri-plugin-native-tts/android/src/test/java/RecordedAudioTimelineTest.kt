package com.readest.native_tts

import org.junit.Assert.*
import org.junit.Test

class RecordedAudioTimelineTest {
    @Test fun timeSkipsCrossTracksAndClamp() {
        val tracks = listOf(RecordedAudioTrack("one", 0.0, 100.0), RecordedAudioTrack("two", 100.0, 200.0))
        assertEquals(RecordedAudioTarget(1, 20_000L), RecordedAudioTimeline.locate(tracks, 120.0))
        assertEquals(RecordedAudioTarget(0, 0L), RecordedAudioTimeline.locate(tracks, -15.0))
        assertEquals(RecordedAudioTarget(1, 199_999L), RecordedAudioTimeline.locate(tracks, 400.0))
    }
    @Test fun choicesUseThirtySecondTolerance() {
        assertFalse(RecordedAudioTimeline.needsChoice(100.0, 130.0))
        assertTrue(RecordedAudioTimeline.needsChoice(100.0, 131.0))
        assertTrue(RecordedAudioTimeline.needsChoice(100.0, 69.0))
    }
}
