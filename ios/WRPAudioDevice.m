#import "WRPBridge.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <UIKit/UIKit.h>
#import <WebRTC/WebRTC.h>
#import <math.h>
#import <objc/message.h>
#import <os/log.h>
#import <stdatomic.h>

#import "WRPPlayoutProcessor.h"

/**
 * The format WebRTC renders into and RemoteIO is fed. Fixed rather than tracking
 * the hardware: RemoteIO resamples to whatever the route runs at, and a constant
 * format means libwebrtc never has to rebuild its playout buffer while the render
 * thread is reading it — which it would do on any change to these three.
 */
static const double kSampleRate = 48000.0;
static const NSInteger kChannels = 2;
static const NSTimeInterval kNominalIOBufferDuration = 0.02;

/** What iOS asks for per render while the screen is locked. */
static const UInt32 kMaxFramesPerSlice = 4096;

/**
 * The Info.plist key the config plugin writes. Every entry is optional; a
 * missing dictionary installs with the defaults below.
 */
static NSString *const kInfoPlistKey = @"WebRtcPlayback";

static os_log_t WRPLog(void) {
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    log = os_log_create("com.fluxlabs.webrtc-playback", "playout");
  });
  return log;
}

static WRPInstallConfig gConfig;
static BOOL gInstalled = NO;

/**
 * A play-only `RTCAudioDevice`: RemoteIO under a `.playback` session.
 *
 * libwebrtc's own iOS device always renders through VoiceProcessingIO, the
 * phone-call audio unit. For a viewer that costs everything a call costs: the
 * stream plays at call volume through call processing, the session has to be
 * `playAndRecord` so the microphone is live (the orange indicator shows while
 * someone is only watching), and speech comes out muffled.
 *
 * `.playback` + `.moviePlayback` is also exactly what `expo-video` sets, so an
 * app switching between WebRTC and HLS never flips the session.
 *
 * Every protocol method is called by libwebrtc on its own ADM thread; the only
 * other thread is the render callback, which touches nothing but the playout
 * block, the processor and the delay line.
 */
@interface WRPPlaybackAudioDevice : NSObject <RTCAudioDevice>
@property(atomic, strong, nullable) id<RTCAudioDeviceDelegate> delegate;
@end

static WRPPlaybackAudioDevice *gDevice;

@implementation WRPPlaybackAudioDevice {
  RTCAudioDeviceGetPlayoutDataBlock _getPlayoutData;
  AudioComponentInstance _unit;
  BOOL _isInitialized;
  BOOL _isPlayoutInitialized;
  /** WebRTC wants playout. Stays set across an interruption, which is what brings the unit back. */
  BOOL _isPlaying;
  NSArray<id<NSObject>> *_observers;
  WRPPlayoutProcessor _processor;
  /** Set from JS, read on the render thread. */
  atomic_bool _levellerEnabled;
  /** The next render resets the processor before using it. */
  atomic_bool _levellerResetPending;
  /** The playout delay's worth of interleaved audio, oldest at `_delayPos`. NULL for no delay. */
  int16_t *_delayLine;
  size_t _delayFrames;
  size_t _delayPos;
}

#pragma mark - Render

/** Swap fresh audio into the delay line, and what went in a playout delay ago out of it. */
static inline void WRPDelay(__unsafe_unretained WRPPlaybackAudioDevice *device,
                            int16_t *audio,
                            UInt32 frames) {
  int16_t *line = device->_delayLine;
  const size_t length = device->_delayFrames;
  size_t pos = device->_delayPos;
  for (UInt32 f = 0; f < frames; f++) {
    int16_t *slot = line + pos * kChannels;
    int16_t *sample = audio + f * kChannels;
    for (NSInteger c = 0; c < kChannels; c++) {
      const int16_t held = slot[c];
      slot[c] = sample[c];
      sample[c] = held;
    }
    if (++pos == length) pos = 0;
  }
  device->_delayPos = pos;
}

/** Empty the delay line. Only while the unit is stopped, so no render is reading it. */
static void WRPClearDelay(WRPPlaybackAudioDevice *device) {
  if (device->_delayLine == NULL) return;
  memset(device->_delayLine, 0, device->_delayFrames * kChannels * sizeof(int16_t));
  device->_delayPos = 0;
}

static OSStatus WRPRender(void *refCon,
                          AudioUnitRenderActionFlags *flags,
                          const AudioTimeStamp *timestamp,
                          UInt32 bus,
                          UInt32 frames,
                          AudioBufferList *io) {
  // Unretained on purpose: the render thread must not retain or release. The
  // device outlives its unit, which is disposed before the device goes away.
  __unsafe_unretained WRPPlaybackAudioDevice *device = (__bridge WRPPlaybackAudioDevice *)refCon;
  __unsafe_unretained RTCAudioDeviceGetPlayoutDataBlock getPlayoutData = device->_getPlayoutData;
  AudioBuffer *buffer = &io->mBuffers[0];

  if (!device->_isPlaying || getPlayoutData == nil) {
    memset(buffer->mData, 0, buffer->mDataByteSize);
    *flags |= kAudioUnitRenderAction_OutputIsSilence;
    return noErr;
  }

  const OSStatus status = getPlayoutData(flags, timestamp, bus, frames, io);
  if (status != noErr || (*flags & kAudioUnitRenderAction_OutputIsSilence)) return status;

  int16_t *samples = (int16_t *)buffer->mData;
  if (gConfig.leveller && atomic_load_explicit(&device->_levellerEnabled, memory_order_relaxed)) {
    if (atomic_exchange_explicit(&device->_levellerResetPending, false, memory_order_acquire)) {
      WRPPlayoutProcessorReset(&device->_processor);
    }
    WRPPlayoutProcessorProcess(&device->_processor, samples, frames);
  }
  if (device->_delayLine != NULL) WRPDelay(device, samples, frames);
  return noErr;
}

#pragma mark - RTCAudioDevice: format

- (double)deviceInputSampleRate {
  return kSampleRate;
}

- (NSTimeInterval)inputIOBufferDuration {
  return kNominalIOBufferDuration;
}

- (NSInteger)inputNumberOfChannels {
  return 1;
}

- (NSTimeInterval)inputLatency {
  return 0;
}

- (double)deviceOutputSampleRate {
  return kSampleRate;
}

- (NSTimeInterval)outputIOBufferDuration {
  return kNominalIOBufferDuration;
}

- (NSInteger)outputNumberOfChannels {
  return kChannels;
}

/**
 * Render-to-ear time, which libwebrtc uses for lip sync: the delay line plus the
 * route. Read live — AirPods add a couple of hundred milliseconds the built-in
 * speaker does not — and refreshed through `notifyAudioOutputParametersChange`
 * whenever the route moves.
 */
- (NSTimeInterval)outputLatency {
  AVAudioSession *session = AVAudioSession.sharedInstance;
  return gConfig.playoutDelayMs / 1000.0 + session.outputLatency + session.IOBufferDuration;
}

#pragma mark - RTCAudioDevice: lifecycle

- (BOOL)isInitialized {
  return _isInitialized;
}

- (BOOL)initializeWithDelegate:(id<RTCAudioDeviceDelegate>)delegate {
  self.delegate = delegate;
  _getPlayoutData = delegate.getPlayoutData;
  WRPPlayoutConfig config = WRPPlayoutConfigDefault();
  config.inputGainDb = (float)gConfig.levellerInputGainDb;
  WRPPlayoutProcessorInit(&_processor, &config, kSampleRate, (int)kChannels);
  if (_delayLine == NULL && gConfig.playoutDelayMs > 0) {
    _delayFrames = (size_t)(kSampleRate * gConfig.playoutDelayMs / 1000);
    _delayLine = calloc(_delayFrames * kChannels, sizeof(int16_t));
    if (_delayLine == NULL) return NO;
  }
  _isInitialized = YES;
  return YES;
}

- (BOOL)terminateDevice {
  [self stopPlayout];
  [self disposeUnit];
  _isPlayoutInitialized = NO;
  // Only once the unit is gone, so no render can still be reading it.
  _getPlayoutData = nil;
  self.delegate = nil;
  _isInitialized = NO;
  return YES;
}

- (void)dealloc {
  [self disposeUnit];
  free(_delayLine);
}

#pragma mark - RTCAudioDevice: playout

- (BOOL)isPlayoutInitialized {
  return _isPlayoutInitialized;
}

- (BOOL)initializePlayout {
  if (!_unit && ![self createUnit]) return NO;
  _isPlayoutInitialized = YES;
  return YES;
}

- (BOOL)isPlaying {
  return _isPlaying;
}

- (BOOL)startPlayout {
  if (_isPlaying) return YES;
  if (!_unit && ![self createUnit]) return NO;

  [self activateSession];
  WRPPlayoutProcessorReset(&_processor);
  atomic_store(&_levellerResetPending, false);
  WRPClearDelay(self);
  _isPlaying = YES;
  [self observeSession];

  const OSStatus status = AudioOutputUnitStart(_unit);
  if (status == noErr) {
    [self logRoute:@"started"];
  } else {
    // Most often a phone call holding the session. Reporting failure would
    // leave libwebrtc believing playout is off with nothing to retry it, so
    // keep the intent and let the interruption end, or the app coming back to
    // the foreground, start the unit.
    os_log_error(WRPLog(), "start failed (%d), waiting for the session", (int)status);
  }

  [self refreshLatency];
  return YES;
}

- (BOOL)stopPlayout {
  if (!_isPlaying) return YES;
  _isPlaying = NO;
  [self unobserveSession];
  if (_unit) AudioOutputUnitStop(_unit);
  // The session is left active on purpose. Deactivating stops every other
  // audio object in the app, and another player may already be taking over;
  // expo-video never deactivates it either.
  os_log(WRPLog(), "stopped");
  return YES;
}

#pragma mark - RTCAudioDevice: recording

// Play-only: a viewer never publishes. Refusing here is what keeps the
// microphone off. An app that also sends audio over react-native-webrtc needs
// libwebrtc's own device, and should not install this package.

- (BOOL)isRecordingInitialized {
  return NO;
}

- (BOOL)initializeRecording {
  os_log_error(WRPLog(), "recording requested from a play-only device");
  return NO;
}

- (BOOL)isRecording {
  return NO;
}

- (BOOL)startRecording {
  return NO;
}

- (BOOL)stopRecording {
  return YES;
}

#pragma mark - Audio unit

- (BOOL)createUnit {
  AudioComponentDescription description = {
      .componentType = kAudioUnitType_Output,
      .componentSubType = kAudioUnitSubType_RemoteIO,
      .componentManufacturer = kAudioUnitManufacturer_Apple,
  };
  AudioComponent component = AudioComponentFindNext(NULL, &description);
  if (component == NULL || AudioComponentInstanceNew(component, &_unit) != noErr) {
    os_log_error(WRPLog(), "no RemoteIO unit");
    _unit = NULL;
    return NO;
  }

  // Output only. RemoteIO's input element is off by default; said explicitly
  // because an enabled input is what would light the microphone indicator.
  UInt32 off = 0;
  UInt32 on = 1;
  AudioStreamBasicDescription format = {
      .mSampleRate = kSampleRate,
      .mFormatID = kAudioFormatLinearPCM,
      .mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
      .mBytesPerPacket = (UInt32)(sizeof(int16_t) * kChannels),
      .mFramesPerPacket = 1,
      .mBytesPerFrame = (UInt32)(sizeof(int16_t) * kChannels),
      .mChannelsPerFrame = (UInt32)kChannels,
      .mBitsPerChannel = 16,
  };
  UInt32 maxFrames = kMaxFramesPerSlice;
  AURenderCallbackStruct callback = {.inputProc = WRPRender, .inputProcRefCon = (__bridge void *)self};

  OSStatus status = AudioUnitSetProperty(
      _unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &off, sizeof(off));
  if (status == noErr) {
    status = AudioUnitSetProperty(
        _unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &on, sizeof(on));
  }
  if (status == noErr) {
    status = AudioUnitSetProperty(
        _unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &format, sizeof(format));
  }
  if (status == noErr) {
    status = AudioUnitSetProperty(_unit,
                                  kAudioUnitProperty_MaximumFramesPerSlice,
                                  kAudioUnitScope_Global,
                                  0,
                                  &maxFrames,
                                  sizeof(maxFrames));
  }
  if (status == noErr) {
    status = AudioUnitSetProperty(_unit,
                                  kAudioUnitProperty_SetRenderCallback,
                                  kAudioUnitScope_Input,
                                  0,
                                  &callback,
                                  sizeof(callback));
  }
  if (status == noErr) status = AudioUnitInitialize(_unit);

  if (status != noErr) {
    os_log_error(WRPLog(), "RemoteIO setup failed (%d)", (int)status);
    AudioComponentInstanceDispose(_unit);
    _unit = NULL;
    return NO;
  }
  return YES;
}

- (void)disposeUnit {
  if (!_unit) return;
  AudioOutputUnitStop(_unit);
  AudioUnitUninitialize(_unit);
  AudioComponentInstanceDispose(_unit);
  _unit = NULL;
}

- (BOOL)isUnitRunning {
  if (!_unit) return NO;
  UInt32 running = 0;
  UInt32 size = sizeof(running);
  AudioUnitGetProperty(
      _unit, kAudioOutputUnitProperty_IsRunning, kAudioUnitScope_Global, 0, &running, &size);
  return running != 0;
}

/**
 * Bring the unit back after the system stopped it. The render thread can change
 * across a restart, and libwebrtc checks it is always called from one thread, so
 * it is told first — while nothing is rendering.
 */
- (void)restartUnit {
  if (!_isPlaying || !_unit) return;
  AudioOutputUnitStop(_unit);
  [self.delegate notifyAudioOutputInterrupted];
  [self activateSession];
  // What the line holds predates the interruption; WebRTC has moved on.
  WRPClearDelay(self);
  const OSStatus status = AudioOutputUnitStart(_unit);
  if (status == noErr) {
    [self logRoute:@"resumed"];
  } else {
    os_log_error(WRPLog(), "resume failed (%d)", (int)status);
  }
  [self refreshLatency];
}

#pragma mark - Session

- (void)activateSession {
  // Left to the app: it owns the session, and something else may be recording.
  if (!gConfig.manageAudioSession) return;
  AVAudioSession *session = AVAudioSession.sharedInstance;
  NSError *error = nil;
  // Not mixable: a live stream takes the audio the way a video does, so music
  // playing in another app pauses rather than talking over the stream.
  const BOOL configured = [session.category isEqualToString:AVAudioSessionCategoryPlayback] &&
                          [session.mode isEqualToString:AVAudioSessionModeMoviePlayback] &&
                          !(session.categoryOptions & AVAudioSessionCategoryOptionMixWithOthers);
  if (!configured && ![session setCategory:AVAudioSessionCategoryPlayback
                                      mode:AVAudioSessionModeMoviePlayback
                                   options:0
                                     error:&error]) {
    os_log_error(WRPLog(), "setCategory failed: %{public}@", error.localizedDescription);
  }
  if (![session setActive:YES error:&error]) {
    os_log_error(WRPLog(), "setActive failed: %{public}@", error.localizedDescription);
  }
}

/** Have libwebrtc re-read `outputLatency`. Nothing else changes, so no buffer is rebuilt. */
- (void)refreshLatency {
  [self onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
    [delegate notifyAudioOutputParametersChange];
  }];
}

/**
 * Session notifications arrive on whatever thread posted them. The unit is only
 * ever touched from libwebrtc's ADM thread, so every handler hops onto it — and
 * drops the work if the device was terminated in between.
 */
- (void)onDeviceThread:(void (^)(id<RTCAudioDeviceDelegate> delegate))work {
  id<RTCAudioDeviceDelegate> delegate = self.delegate;
  if (delegate == nil) return;
  __weak WRPPlaybackAudioDevice *weakSelf = self;
  [delegate dispatchAsync:^{
    WRPPlaybackAudioDevice *strongSelf = weakSelf;
    if (strongSelf == nil || strongSelf.delegate != delegate) return;
    work(delegate);
  }];
}

- (void)observeSession {
  if (_observers) return;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  AVAudioSession *session = AVAudioSession.sharedInstance;
  __weak WRPPlaybackAudioDevice *weakSelf = self;

  id interruption =
      [center addObserverForName:AVAudioSessionInterruptionNotification
                          object:session
                           queue:nil
                      usingBlock:^(NSNotification *note) {
                        const NSUInteger type =
                            [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
                        [weakSelf onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
                          WRPPlaybackAudioDevice *device = weakSelf;
                          if (type == AVAudioSessionInterruptionTypeBegan) {
                            os_log(WRPLog(), "interrupted");
                            [delegate notifyAudioOutputInterrupted];
                          } else {
                            // Resumed whether or not iOS says `shouldResume`:
                            // this is live, and a viewer who comes back from a
                            // call expects the stream, not silence.
                            [device restartUnit];
                          }
                        }];
                      }];

  id reset = [center addObserverForName:AVAudioSessionMediaServicesWereResetNotification
                                 object:session
                                  queue:nil
                             usingBlock:^(NSNotification *note) {
                               [weakSelf onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
                                 WRPPlaybackAudioDevice *device = weakSelf;
                                 // Every audio object is dead after a reset.
                                 os_log(WRPLog(), "media services reset");
                                 [device disposeUnit];
                                 if ([device createUnit]) [device restartUnit];
                               }];
                             }];

  id route = [center addObserverForName:AVAudioSessionRouteChangeNotification
                                 object:session
                                  queue:nil
                             usingBlock:^(NSNotification *note) {
                               [weakSelf onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
                                 [weakSelf logRoute:@"route changed"];
                                 [delegate notifyAudioOutputParametersChange];
                               }];
                             }];

  // iOS does not always post the end of an interruption. Coming back to the
  // foreground is the backstop: a unit that should be running but is not gets
  // started again.
  id active = [center addObserverForName:UIApplicationDidBecomeActiveNotification
                                  object:nil
                                   queue:nil
                              usingBlock:^(NSNotification *note) {
                                [weakSelf onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
                                  WRPPlaybackAudioDevice *device = weakSelf;
                                  if (![device isUnitRunning]) [device restartUnit];
                                }];
                              }];

  _observers = @[ interruption, reset, route, active ];
}

- (void)unobserveSession {
  for (id observer in _observers) [NSNotificationCenter.defaultCenter removeObserver:observer];
  _observers = nil;
}

#pragma mark - Logging

- (void)logRoute:(NSString *)event {
  AVAudioSession *session = AVAudioSession.sharedInstance;
  NSString *outputs = [[session.currentRoute.outputs valueForKey:@"portType"] componentsJoinedByString:@","];
  os_log(WRPLog(),
         "%{public}@: %{public}@ %.0f Hz, io %.1f ms, latency %.1f ms, delay %.0f ms, category %{public}@/%{public}@",
         event,
         outputs,
         session.sampleRate,
         session.IOBufferDuration * 1000,
         session.outputLatency * 1000,
         gConfig.playoutDelayMs,
         session.category,
         session.mode);
}

#pragma mark - Bridge support

- (BOOL)levellerEnabled {
  return atomic_load(&_levellerEnabled);
}

- (void)setLevellerEnabled:(BOOL)enabled {
  // Re-enabling starts from a clean state: the gain it last held belongs to
  // audio that has long since played.
  if (enabled && !atomic_load(&_levellerEnabled)) atomic_store(&_levellerResetPending, true);
  atomic_store(&_levellerEnabled, enabled);
}

- (WRPPlayoutStats)takeStats {
  return WRPPlayoutProcessorTakeStats(&_processor);
}

@end

#pragma mark - Install

static double WRPNumber(NSDictionary *plist, NSString *key, double fallback, double min, double max) {
  id value = plist[key];
  if (![value isKindOfClass:NSNumber.class]) return fallback;
  const double number = [value doubleValue];
  return number < min ? min : (number > max ? max : number);
}

static BOOL WRPBool(NSDictionary *plist, NSString *key, BOOL fallback) {
  id value = plist[key];
  return [value isKindOfClass:NSNumber.class] ? [value boolValue] : fallback;
}

/**
 * react-native-webrtc's `WebRTCModuleOptions` singleton, found at run time.
 *
 * Not imported: a pod with Swift in it may only depend on pods that define
 * modules, and react-native-webrtc does not, so declaring it would force every
 * app built with static libraries to change its Podfile. The two properties set
 * here (`audioDevice`, `fieldTrials`) are react-native-webrtc 124's public API.
 */
static id WRPWebRTCModuleOptions(void) {
  Class optionsClass = NSClassFromString(@"WebRTCModuleOptions");
  if (optionsClass == Nil || ![optionsClass respondsToSelector:@selector(sharedInstance)]) return nil;
  id options = ((id (*)(Class, SEL))objc_msgSend)(optionsClass, @selector(sharedInstance));
  if (![options respondsToSelector:@selector(setAudioDevice:)] ||
      ![options respondsToSelector:@selector(setFieldTrials:)]) {
    return nil;
  }
  return options;
}

/**
 * Sets the device and field trials on react-native-webrtc. Runs from `+load`,
 * before `main`: react-native-webrtc reads its options once, when it builds its
 * peer connection factory, and nothing on the JS side runs early enough. Every
 * class in the image is registered before any `+load` runs, so the lookup
 * above already works here.
 */
static void WRPInstall(void) {
  NSDictionary *plist = [NSBundle.mainBundle objectForInfoDictionaryKey:kInfoPlistKey];
  if (![plist isKindOfClass:NSDictionary.class]) plist = @{};
  if (!WRPBool(plist, @"enabled", YES)) {
    os_log(WRPLog(), "disabled in Info.plist; libwebrtc's own audio device stays");
    return;
  }

  // 10 s is where libwebrtc stops honouring a playout delay.
  const double delay = WRPNumber(plist, @"playoutDelayMs", 0, 0, 10000);
  gConfig = (WRPInstallConfig){
      .playoutDelayMs = delay,
      .maxPlayoutDelayMs = WRPNumber(plist, @"maxPlayoutDelayMs", MAX(2500, delay), delay, 10000),
      .leveller = WRPBool(plist, @"leveller", YES),
      .levellerInputGainDb = WRPNumber(plist, @"levellerInputGainDb", 15, 0, 30),
      .manageAudioSession = WRPBool(plist, @"manageAudioSession", YES),
      .networkResilience = WRPBool(plist, @"networkResilience", YES),
  };

  id options = WRPWebRTCModuleOptions();
  if (options == nil) {
    os_log_error(WRPLog(), "react-native-webrtc 124+ is not in this app; nothing installed");
    return;
  }
  if ([options valueForKey:@"audioDevice"] != nil) {
    os_log_error(WRPLog(), "an audio device is already set; leaving it");
    return;
  }
  gDevice = [[WRPPlaybackAudioDevice alloc] init];
  [gDevice setLevellerEnabled:gConfig.leveller];
  [options setValue:gDevice forKey:@"audioDevice"];

  NSDictionary *existing = [options valueForKey:@"fieldTrials"];
  NSMutableDictionary *trials = [existing isKindOfClass:NSDictionary.class]
                                    ? [existing mutableCopy]
                                    : [NSMutableDictionary dictionary];
  if (gConfig.playoutDelayMs > 0) {
    // Only alongside the device: the forced video delay is matched by its
    // delay line, which is what keeps the voice on the picture from the first
    // frame. libwebrtc can delay only the video; left to lip sync, audio would
    // be dragged along at 80 ms a second.
    trials[@"WebRTC-ForcePlayoutDelay"] = [NSString
        stringWithFormat:@"min_ms:%.0f,max_ms:%.0f", gConfig.playoutDelayMs, gConfig.maxPlayoutDelayMs];
  }
  if (gConfig.networkResilience) {
    // While packets are being lost, wait a whole round trip for the resend.
    // The default caps the wait at 200 ms, which a mobile network outlasts.
    trials[@"WebRTC-RttMult"] = @"Disabled";
    // A keyframe of a sharp stream arrives as one burst; 256 KB overflows.
    trials[@"WebRTC-ReceiveBufferSize"] = @"size_bytes:1048576";
  }
  if (trials.count > 0) {
    // react-native-webrtc sets this one only when no trials are given at all,
    // and it is how a switch between Wi-Fi and cellular gets noticed.
    trials[kRTCFieldTrialUseNWPathMonitor] = kRTCFieldTrialEnabledValue;
    [options setValue:trials forKey:@"fieldTrials"];
  }
  gInstalled = YES;
}

@interface WRPInstaller : NSObject
@end

@implementation WRPInstaller

+ (void)load {
  WRPInstall();
}

@end

#pragma mark - Bridge

bool WRPIsInstalled(void) {
  return gInstalled;
}

bool WRPIsPlaying(void) {
  return gDevice != nil && [gDevice isPlaying];
}

WRPInstallConfig WRPGetInstallConfig(void) {
  return gConfig;
}

bool WRPGetLevellerEnabled(void) {
  return gDevice != nil && [gDevice levellerEnabled];
}

void WRPSetLevellerEnabled(bool enabled) {
  if (gDevice != nil && gConfig.leveller) [gDevice setLevellerEnabled:enabled];
}

bool WRPTakeLevels(double *inputPeakDb, double *outputPeakDb, double *maxReductionDb) {
  if (gDevice == nil || !gConfig.leveller || ![gDevice isPlaying] || ![gDevice levellerEnabled]) {
    return false;
  }
  const WRPPlayoutStats stats = [gDevice takeStats];
  *inputPeakDb = stats.inputPeak > 0 ? 20 * log10f(stats.inputPeak) : -120.0;
  *outputPeakDb = stats.outputPeak > 0 ? 20 * log10f(stats.outputPeak) : -120.0;
  *maxReductionDb = stats.maxReductionDb;
  return true;
}
