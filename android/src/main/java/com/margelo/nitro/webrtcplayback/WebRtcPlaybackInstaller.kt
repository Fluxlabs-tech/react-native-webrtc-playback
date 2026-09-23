package com.margelo.nitro.webrtcplayback

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioTrack
import android.media.audiofx.AudioEffect
import android.media.audiofx.DynamicsProcessing
import android.media.audiofx.LoudnessEnhancer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.oney.WebRTCModule.WebRTCModuleOptions
import org.webrtc.audio.JavaAudioDeviceModule

/** What the package installs with — read once from AndroidManifest meta-data. */
data class InstallConfig(
  val playoutDelayMs: Int = 0,
  val maxPlayoutDelayMs: Int = 2500,
  val leveller: Boolean = true,
  val levellerInputGainDb: Float = 15f,
  val audioFocus: Boolean = true,
  val networkResilience: Boolean = true,
)

/**
 * Plays react-native-webrtc's remote audio as media, through a voice leveller.
 *
 * MEDIA PATH — libwebrtc's default playout attributes are
 * `USAGE_VOICE_COMMUNICATION` / `CONTENT_TYPE_SPEECH`, which routes the stream
 * through the telephony post-processing chain, band-limits it and rides the call
 * volume. A viewer never publishes, so this hands react-native-webrtc a module
 * that plays as `USAGE_MEDIA`, on the media volume and the loudspeaker.
 *
 * LEVELLER — the platform's DynamicsProcessing effect is attached to WebRTC's
 * own AudioTrack session with the same chain the iOS device runs in software:
 * input gain, compressor, limiter. Its numbers mirror `WRPPlayoutConfigDefault`
 * in `ios/WRPPlayoutProcessor.c`; change them together.
 *
 * FOCUS — WebRTC's track never asks for audio focus, so another app's music kept
 * playing over the stream. It now takes focus the way a video player does, and
 * goes quiet for a phone call.
 */
object WebRtcPlaybackInstaller {
  private const val TAG = "WebRtcPlayback"

  private const val THRESHOLD_DB = -20f
  private const val RATIO = 4f
  private const val KNEE_DB = 6f

  /**
   * Slow, so the compressor follows the speaker's level rather than each
   * syllable and pauses do not swell with room noise. iOS also holds the gain
   * through pauses, which DynamicsProcessing cannot; at these times that is
   * worth under 1 dB.
   */
  private const val ATTACK_MS = 30f
  private const val RELEASE_MS = 2000f
  private const val CEILING_DB = -1f
  private const val LIMITER_ATTACK_MS = 1f
  private const val LIMITER_RELEASE_MS = 60f
  private const val LIMITER_RATIO = 10f

  /** One band spanning the whole spectrum: this is a leveller, not a multiband EQ. */
  private const val FULL_BAND_HZ = 20_000f

  /**
   * DynamicsProcessing is API 28+, and an OEM build can lack it. LoudnessEnhancer
   * is a compressor-backed boost that exists everywhere; this is its target.
   */
  private const val FALLBACK_LOUDNESS_MB = 600

  /**
   * libwebrtc sizes its AudioTrack at the platform minimum, which underruns — an
   * audible crackle — whenever the audio thread is late. Twice the minimum costs
   * a few tens of milliseconds of latency, which a one-way stream does not feel.
   */
  private const val PLAYOUT_BUFFER_TRIAL = "WebRTC-AudioDevicePlayoutBufferSizeFactor/2.0/"

  /**
   * While packets are being lost, video waits a whole round trip for the resend
   * (libwebrtc caps that wait at 200 ms by default, which a mobile network
   * outlasts), and the socket buffer holds a sharp stream's keyframe burst
   * (256 KB overflows).
   */
  private const val NETWORK_TRIALS =
    "WebRTC-RttMult/Disabled/WebRTC-ReceiveBufferSize/size_bytes:1048576/"

  private val playoutAttributes: AudioAttributes =
    AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
      .build()

  @Volatile
  var isInstalled = false
    private set

  @Volatile
  var isPlaying = false
    private set

  @Volatile
  var config = InstallConfig()
    private set

  private lateinit var appContext: Context
  private var module: JavaAudioDeviceModule? = null

  // Playout starts on WebRTC's audio thread and stops on its worker thread.
  private val lock = Any()
  private var effect: AudioEffect? = null
  private var focusRequest: AudioFocusRequest? = null
  private var levellerOn = true

  /** Switches the attached leveller; applies to the next playout too. */
  var levellerEnabled: Boolean
    get() = synchronized(lock) { config.leveller && levellerOn }
    set(value) {
      synchronized(lock) {
        if (!config.leveller) return
        levellerOn = value
        effect?.enabled = value
      }
    }

  private val focusListener =
    AudioManager.OnAudioFocusChangeListener { change ->
      when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> module?.setSpeakerMute(false)
        // A call, an assistant, a navigation prompt. Muted rather than stopped:
        // a live source will not resume a stopped play session.
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> module?.setSpeakerMute(true)
        // Left playing on a permanent loss. A live stream has no play button to
        // come back with, so silencing it would strand the viewer for the rest
        // of the stream; the other app is one the viewer just started.
        AudioManager.AUDIOFOCUS_LOSS -> Unit
        // AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK is handled by the system on API 26+.
      }
    }

  fun install(context: Context, installConfig: InstallConfig) {
    if (isInstalled) return
    val options = WebRTCModuleOptions.getInstance()
    if (options.audioDeviceModule != null) {
      Log.w(TAG, "an audio device module is already set; leaving it")
      return
    }
    appContext = context.applicationContext
    config = installConfig

    val adm =
      JavaAudioDeviceModule.builder(appContext)
        .setAudioAttributes(playoutAttributes)
        .setAudioTrackStateCallback(
          object : JavaAudioDeviceModule.AudioTrackStateCallback {
            override fun onWebRtcAudioTrackStart() = onPlayoutStarted()

            override fun onWebRtcAudioTrackStop() = onPlayoutStopped()
          },
        )
        // What react-native-webrtc builds its default module with.
        .setEnableVolumeLogger(false)
        .createAudioDeviceModule()

    module = adm
    options.audioDeviceModule = adm

    var trials = PLAYOUT_BUFFER_TRIAL
    if (installConfig.networkResilience) trials += NETWORK_TRIALS
    if (installConfig.playoutDelayMs > 0) {
      // Video only: Android has no hook for holding audio back to match, so lip
      // sync drags the voice along at 80 ms a second and it runs ahead of the
      // picture for the first seconds of every session. Opt-in for that reason.
      trials +=
        "WebRTC-ForcePlayoutDelay/min_ms:${installConfig.playoutDelayMs}," +
        "max_ms:${installConfig.maxPlayoutDelayMs}/"
    }
    options.fieldTrials = (options.fieldTrials ?: "") + trials
    isInstalled = true
  }

  private fun onPlayoutStarted() {
    val track = webRtcAudioTrack()
    synchronized(lock) {
      isPlaying = true
      releaseEffect()
      if (config.leveller) {
        effect = track?.let { attachLeveller(it.audioSessionId) }?.apply { enabled = levellerOn }
      }
      if (config.audioFocus) requestFocus()
    }
  }

  private fun onPlayoutStopped() {
    synchronized(lock) {
      isPlaying = false
      releaseEffect()
      abandonFocus()
    }
  }

  /**
   * The AudioTrack libwebrtc plays through. JavaAudioDeviceModule exposes neither
   * it nor its session id, so it is read by field name — names the
   * `-keep class org.webrtc.** { *; }` rule in react-native-webrtc's consumer
   * ProGuard file preserves in release builds.
   */
  private fun webRtcAudioTrack(): AudioTrack? {
    val adm = module ?: return null
    return try {
      val output =
        JavaAudioDeviceModule::class.java
          .getDeclaredField("audioOutput")
          .apply { isAccessible = true }
          .get(adm) ?: return null
      output.javaClass
        .getDeclaredField("audioTrack")
        .apply { isAccessible = true }
        .get(output) as? AudioTrack
    } catch (e: Exception) {
      Log.w(TAG, "could not reach WebRTC's AudioTrack; playing without the leveller", e)
      null
    }
  }

  /**
   * Engine layouts to offer DynamicsProcessing, in order. Implementations differ
   * on what `setEngineArchitecture` accepts — some want unused stages declared
   * with zero bands, some reject a zero-band stage, and not every build takes
   * both resolution variants — so each is tried until one is accepted.
   */
  private data class Layout(val variant: Int, val unusedStageBands: Int) {
    override fun toString(): String =
      (if (variant == DynamicsProcessing.VARIANT_FAVOR_TIME_RESOLUTION) "time" else "frequency") +
        " resolution, $unusedStageBands-band unused stages"
  }

  private val layouts =
    listOf(
      Layout(DynamicsProcessing.VARIANT_FAVOR_TIME_RESOLUTION, 0),
      Layout(DynamicsProcessing.VARIANT_FAVOR_TIME_RESOLUTION, 1),
      Layout(DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 0),
      Layout(DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 1),
    )

  private fun attachLeveller(sessionId: Int): AudioEffect? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      for (layout in layouts) {
        try {
          return dynamicsProcessing(sessionId, layout).also {
            Log.i(TAG, "leveller on session $sessionId: DynamicsProcessing ($layout)")
          }
        } catch (e: Exception) {
          Log.w(TAG, "DynamicsProcessing rejected $layout: ${e.message}")
        }
      }
      Log.w(TAG, "DynamicsProcessing unavailable, falling back to LoudnessEnhancer")
    }
    return try {
      LoudnessEnhancer(sessionId)
        .apply {
          setTargetGain(FALLBACK_LOUDNESS_MB)
          enabled = true
        }.also { Log.i(TAG, "leveller on session $sessionId: LoudnessEnhancer") }
    } catch (e: Exception) {
      Log.w(TAG, "no leveller available; playing at unity gain", e)
      null
    }
  }

  private fun dynamicsProcessing(sessionId: Int, layout: Layout): DynamicsProcessing {
    val dpConfig =
      DynamicsProcessing.Config.Builder(
        layout.variant,
        2,
        false,
        layout.unusedStageBands,
        true,
        1,
        false,
        layout.unusedStageBands,
        true,
      )
        .setInputGainAllChannelsTo(config.levellerInputGainDb)
        .setMbcAllChannelsTo(
          DynamicsProcessing.Mbc(true, true, 1).apply {
            setBand(
              0,
              DynamicsProcessing.MbcBand(
                true,
                FULL_BAND_HZ,
                ATTACK_MS,
                RELEASE_MS,
                RATIO,
                THRESHOLD_DB,
                KNEE_DB,
                // Noise gate and expander off.
                -90f,
                1f,
                0f,
                0f,
              ),
            )
          },
        )
        .setLimiterAllChannelsTo(
          DynamicsProcessing.Limiter(
            true,
            true,
            0,
            LIMITER_ATTACK_MS,
            LIMITER_RELEASE_MS,
            LIMITER_RATIO,
            CEILING_DB,
            0f,
          ),
        )
        .build()
    return DynamicsProcessing(0, sessionId, dpConfig).apply { enabled = true }
  }

  private fun releaseEffect() {
    effect?.release()
    effect = null
  }

  private fun requestFocus() {
    val audioManager = appContext.getSystemService(AudioManager::class.java) ?: return
    val request =
      AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(playoutAttributes)
        .setAcceptsDelayedFocusGain(true)
        .setOnAudioFocusChangeListener(focusListener, Handler(Looper.getMainLooper()))
        .build()
    focusRequest = request
    when (audioManager.requestAudioFocus(request)) {
      AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> module?.setSpeakerMute(false)
      // A call is in progress; AUDIOFOCUS_GAIN arrives when it ends.
      AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> module?.setSpeakerMute(true)
      // Refused outright: play anyway rather than leave the stream silent.
      else -> Log.w(TAG, "audio focus refused")
    }
  }

  private fun abandonFocus() {
    val request = focusRequest ?: return
    appContext.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(request)
    focusRequest = null
    module?.setSpeakerMute(false)
  }
}
