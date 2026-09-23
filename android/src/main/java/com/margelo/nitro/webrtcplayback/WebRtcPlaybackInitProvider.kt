package com.margelo.nitro.webrtcplayback

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.util.Log

/**
 * Installs the playout path at process start.
 *
 * react-native-webrtc reads its audio device module and field trials once, when
 * it builds its peer connection factory, and nothing on the JS side runs early
 * enough to set them. A ContentProvider's `onCreate` runs before
 * `Application.onCreate` — before React Native exists — with no code needed in
 * the host app.
 */
class WebRtcPlaybackInitProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    val context = context ?: return false
    try {
      val meta = metaData(context)
      if (!meta.bool("enabled", true)) {
        Log.i(TAG, "disabled in the manifest; libwebrtc's own audio device stays")
        return true
      }
      WebRtcPlaybackInstaller.install(context, readConfig(meta))
    } catch (e: Throwable) {
      // Never take the app down over audio: without the package, react-native-webrtc
      // falls back to its own module.
      Log.e(TAG, "install failed; libwebrtc's own audio device stays", e)
    }
    return true
  }

  private fun metaData(context: Context): Bundle =
    try {
      context.packageManager
        .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        .metaData ?: Bundle()
    } catch (e: PackageManager.NameNotFoundException) {
      Bundle()
    }

  private fun readConfig(meta: Bundle): InstallConfig {
    // 10 s is where libwebrtc stops honouring a playout delay.
    val delay = meta.number("playoutDelayMs", 0.0).coerceIn(0.0, 10_000.0).toInt()
    val defaults = InstallConfig()
    return InstallConfig(
      playoutDelayMs = delay,
      maxPlayoutDelayMs =
        meta.number("maxPlayoutDelayMs", maxOf(2500, delay).toDouble())
          .coerceIn(delay.toDouble(), 10_000.0)
          .toInt(),
      leveller = meta.bool("leveller", defaults.leveller),
      levellerInputGainDb =
        meta.number("levellerInputGainDb", defaults.levellerInputGainDb.toDouble())
          .coerceIn(0.0, 30.0)
          .toFloat(),
      audioFocus = meta.bool("audioFocus", defaults.audioFocus),
      networkResilience = meta.bool("networkResilience", defaults.networkResilience),
    )
  }

  // The manifest hands meta-data back as whatever type it parsed the literal as.
  // `Bundle.get` is deprecated for typed getters, which would each reject the
  // other types; this has to accept all of them.
  @Suppress("DEPRECATION")
  private fun Bundle.number(key: String, fallback: Double): Double =
    when (val value = get(PREFIX + key)) {
      is Number -> value.toDouble()
      is String -> value.toDoubleOrNull() ?: fallback
      else -> fallback
    }

  @Suppress("DEPRECATION")
  private fun Bundle.bool(key: String, fallback: Boolean): Boolean =
    when (val value = get(PREFIX + key)) {
      is Boolean -> value
      is String -> value.toBooleanStrictOrNull() ?: fallback
      else -> fallback
    }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  private companion object {
    const val TAG = "WebRtcPlayback"

    /** What the config plugin prefixes every meta-data name with. */
    const val PREFIX = "com.fluxlabs.webrtcplayback."
  }
}
