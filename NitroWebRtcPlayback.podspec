require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "NitroWebRtcPlayback"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  # RTCAudioDevice, which this is, needs the WebRTC M114+ that react-native-webrtc
  # 124 ships (JitsiWebRTC 124).
  s.platforms    = { :ios => "15.1" }
  s.source       = { :git => "https://github.com/Fluxlabs-tech/react-native-webrtc-playback.git", :tag => "#{s.version}" }

  s.source_files = [
    "ios/**/*.{swift,h,hpp,m,mm,c,cpp}",
  ]
  # The C bridge is how the Swift HybridObject reaches the Objective-C device.
  s.public_header_files = ["ios/WRPBridge.h"]

  s.frameworks = "AVFoundation", "AudioToolbox"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_VERSION" => "5.0",
  }

  s.dependency "React-Core"
  # The WebRTC framework react-native-webrtc 124 ships, for RTCAudioDevice.
  # react-native-webrtc itself is reached at run time (see WRPAudioDevice.m): a
  # Swift pod may only depend on pods that define modules, and it does not.
  s.dependency "JitsiWebRTC"

  load "nitrogen/generated/ios/NitroWebRtcPlayback+autolinking.rb"
  add_nitrogen_files(s)
end
