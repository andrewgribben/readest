package com.readest.native_bridge

import android.app.WallpaperManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Sets a book cover as the device wallpaper: sharp on the lock screen, blurred
 * on the home screen.
 *
 * The bitmaps keep the cover's own aspect ratio and no crop hint is passed, so
 * the system centre-crops each one to fill whichever screen shows it. On a
 * foldable that is done per display, which a crop computed here could not do.
 */
object CoverWallpaper {
    /** Covers smaller than this (long side) are scaled up before blurring so the blur stays smooth. */
    private const val MIN_LONG_SIDE = 1600

    /** How far the blur pyramid shrinks the image; larger is blurrier. */
    private const val BLUR_DOWNSCALE = 24

    data class Result(val home: Boolean, val lock: Boolean, val error: String? = null)

    fun apply(context: Context, coverPath: String, home: Boolean, lock: Boolean): Result {
        val file = File(coverPath)
        if (!file.exists()) return Result(false, false, "Cover file does not exist")
        val decoded = BitmapFactory.decodeFile(file.absolutePath)
            ?: return Result(false, false, "Cover could not be decoded")
        val cover = ensureMinSize(decoded, MIN_LONG_SIDE)
        val manager = WallpaperManager.getInstance(context)
        if (!manager.isWallpaperSupported || !manager.isSetWallpaperAllowed) {
            return Result(false, false, "Wallpaper changes are not allowed on this device")
        }
        // Home first: while the lock screen still follows the home wallpaper,
        // setting home alone would change both. Setting lock afterwards splits them.
        var homeOk = false
        var lockOk = false
        if (home) {
            val blurred = blur(cover, BLUR_DOWNSCALE)
            homeOk = manager.setBitmap(blurred, null, true, WallpaperManager.FLAG_SYSTEM) != 0
            if (blurred !== cover) blurred.recycle()
        }
        if (lock) {
            lockOk = manager.setBitmap(cover, null, true, WallpaperManager.FLAG_LOCK) != 0
        }
        if (cover !== decoded) cover.recycle()
        decoded.recycle()
        return Result(homeOk, lockOk)
    }

    private fun ensureMinSize(src: Bitmap, minLongSide: Int): Bitmap {
        val long = max(src.width, src.height)
        if (long >= minLongSide) return src
        val scale = minLongSide.toFloat() / long
        return Bitmap.createScaledBitmap(
            src,
            (src.width * scale).roundToInt(),
            (src.height * scale).roundToInt(),
            true,
        )
    }

    /**
     * A dependency-free blur: halve the image with bilinear filtering until it
     * is [downscale] times smaller, then double it back up the same way. Each
     * step averages neighbouring pixels, so the result is close to a Gaussian
     * without RenderScript (deprecated) or a View to draw a RenderEffect on.
     */
    fun blur(src: Bitmap, downscale: Int): Bitmap {
        val steps = blurSteps(downscale)
        val sizes = mutableListOf(src.width to src.height)
        var current = src
        repeat(steps) {
            val w = max(1, current.width / 2)
            val h = max(1, current.height / 2)
            val next = Bitmap.createScaledBitmap(current, w, h, true)
            if (current !== src) current.recycle()
            current = next
            sizes.add(w to h)
        }
        for (i in sizes.size - 2 downTo 0) {
            val (w, h) = sizes[i]
            val next = Bitmap.createScaledBitmap(current, w, h, true)
            current.recycle()
            current = next
        }
        return current
    }

    /** Number of halvings needed to shrink by at least [downscale]. */
    fun blurSteps(downscale: Int): Int {
        var steps = 0
        var factor = 1
        while (factor < downscale) {
            factor *= 2
            steps++
        }
        return steps
    }
}
