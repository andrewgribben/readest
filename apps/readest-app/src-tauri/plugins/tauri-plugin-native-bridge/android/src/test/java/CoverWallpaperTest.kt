package com.readest.native_bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Host-JVM tests for the cover wallpaper blur. */
class CoverWallpaperTest {
    private fun red(p: Int) = (p shr 16) and 0xFF

    @Test
    fun flatImageStaysFlat() {
        val px = IntArray(20 * 10) { 0xFF336699.toInt() }
        val out = CoverWallpaper.gaussianBlur(px, 20, 10, 4)
        assertTrue(out.all { it == 0xFF336699.toInt() })
    }

    @Test
    fun hardEdgeBecomesASmoothRamp() {
        // Left half black, right half white: a blur must give a steadily
        // rising ramp with many steps; pixelation shows as plateaus and jumps.
        val w = 60
        val h = 3
        val px = IntArray(w * h) { i ->
            if (i % w < w / 2) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
        }
        val out = CoverWallpaper.gaussianBlur(px, w, h, 5)
        val row = (0 until w).map { red(out[w + it]) }
        for (x in 1 until w) assertTrue("x=$x ${row[x - 1]} -> ${row[x]}", row[x] >= row[x - 1])
        assertEquals(0, row.first())
        assertEquals(255, row.last())
        assertTrue(row[w / 2] in 100..160)
        assertTrue(row.distinct().size > 10)
    }

    @Test
    fun alphaIsKept() {
        val px = IntArray(8 * 8) { 0x80FFFFFF.toInt() }
        val out = CoverWallpaper.gaussianBlur(px, 8, 8, 2)
        assertTrue(out.all { (it ushr 24) == 0x80 })
    }
}
