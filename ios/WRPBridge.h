// The C surface of the iOS playout device, for the Swift HybridObject.
//
// Plain C on purpose: Nitro compiles Swift with C++ interop (`objcxx`), and a C
// header imports cleanly into it without dragging WebRTC's Objective-C headers
// into the Swift module.

#ifndef WRP_BRIDGE_H
#define WRP_BRIDGE_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** What the device installed with — read once from Info.plist at launch. */
typedef struct {
  double playoutDelayMs;
  double maxPlayoutDelayMs;
  bool leveller;
  double levellerInputGainDb;
  bool manageAudioSession;
  bool networkResilience;
} WRPInstallConfig;

/** The device is set on react-native-webrtc. */
bool WRPIsInstalled(void);

/** WebRTC is playing audio through the device right now. */
bool WRPIsPlaying(void);

WRPInstallConfig WRPGetInstallConfig(void);

bool WRPGetLevellerEnabled(void);

/** Takes effect on the next render. Re-enabling starts the leveller afresh. */
void WRPSetLevellerEnabled(bool enabled);

/**
 * Peak levels through the leveller since the previous call, and resets them.
 * Returns false when there is nothing to report: not playing, or the leveller
 * is off.
 */
bool WRPTakeLevels(double *inputPeakDb, double *outputPeakDb, double *maxReductionDb);

#ifdef __cplusplus
}
#endif

#endif  // WRP_BRIDGE_H
