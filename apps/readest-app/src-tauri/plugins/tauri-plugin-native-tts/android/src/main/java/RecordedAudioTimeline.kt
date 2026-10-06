package com.readest.native_tts

internal data class RecordedAudioTrack(val path: String, val startOffset: Double, val duration: Double)
internal data class RecordedAudioTarget(val index: Int, val positionMs: Long)
internal object RecordedAudioTimeline {
    const val CHOICE_THRESHOLD_SECONDS = 30.0
    fun needsChoice(listening: Double, reading: Double): Boolean =
        kotlin.math.abs(listening - reading) > CHOICE_THRESHOLD_SECONDS
    fun locate(tracks: List<RecordedAudioTrack>, seconds: Double): RecordedAudioTarget {
        require(tracks.isNotEmpty() && seconds.isFinite())
        val last = tracks.last()
        val target = seconds.coerceIn(0.0, last.startOffset + last.duration - 0.001)
        val index = tracks.indexOfLast { it.startOffset <= target }.coerceAtLeast(0)
        return RecordedAudioTarget(index, ((target - tracks[index].startOffset) * 1000).toLong())
    }
}
