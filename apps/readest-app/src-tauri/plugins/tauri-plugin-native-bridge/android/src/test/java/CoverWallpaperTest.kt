package com.readest.native_bridge

import org.junit.Assert.assertEquals
import org.junit.Test

/** Host-JVM tests for the cover wallpaper blur pyramid depth. */
class CoverWallpaperTest {
    @Test
    fun blurStepsReachAtLeastTheRequestedDownscale() {
        assertEquals(0, CoverWallpaper.blurSteps(1))
        assertEquals(1, CoverWallpaper.blurSteps(2))
        assertEquals(4, CoverWallpaper.blurSteps(16))
        assertEquals(5, CoverWallpaper.blurSteps(24))
        assertEquals(5, CoverWallpaper.blurSteps(32))
    }
}
