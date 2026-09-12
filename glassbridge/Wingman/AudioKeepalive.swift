// AudioKeepalive.swift — silent-audio lock survival (DESIGN.md §5.1 responsibility 2, DESIGN_MAC.md §1).
// `audio` UIBackgroundMode + AVAudioSession .playback/.mixWithOthers + a looped silent file keeps OUR PROCESS
// alive while the phone is locked; whether the DAT stream keeps delivering is Meta's behavior (M2 screen-lock test).
// Sideload-only trick (App Store review would reject it).
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: none — Windows-independent
// CONTRACT: DESIGN.md §5.1 keepalive; DESIGN.md §6 M2 screen-lock test
// AT-INTEGRATION: re-run the 5-minute locked-phone stream against live Cortex at M2 (first against DevHarness, DESIGN_MAC.md §2.5).
//
// INTEGRATION: AudioKeepalive
// IN:  start() when the session is armed, stop() at Stop / session_end (BridgeController)
// OUT: nothing
// WIRE: one instance owned by BridgeController

import Foundation

/// 1 s of 8 kHz mono 16-bit PCM silence, written once to tmp — no binary asset in git.
enum SilentWav {
  static func url() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("wingman-silence.wav")
    if FileManager.default.fileExists(atPath: url.path) { return url }
    let sampleRate: UInt32 = 8000, bytes: UInt32 = 8000 * 2
    var d = Data()
    func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8)); le32(36 + bytes); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); le32(16); le16(1); le16(1); le32(sampleRate); le32(sampleRate * 2); le16(2); le16(16)
    d.append(contentsOf: Array("data".utf8)); le32(bytes); d.append(Data(count: Int(bytes)))
    try? d.write(to: url)
    return url
  }
}

#if os(iOS)
import AVFoundation

final class AudioKeepalive {
  private(set) var isRunning = false
  private var player: AVAudioPlayer?
  private var interruptionObserver: NSObjectProtocol?

  func start() {
    guard !isRunning else { return }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      try session.setActive(true)
      let p = try AVAudioPlayer(contentsOf: SilentWav.url())
      p.numberOfLoops = -1
      p.volume = 1.0            // the file itself is silent; volume 0 can get the session deprioritized
      p.prepareToPlay()
      p.play()
      player = p
      isRunning = true
      // Phone call / Siri pauses us silently otherwise — restart when the interruption ends.
      interruptionObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
          guard let self, self.isRunning else { return }
          let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
          guard raw.flatMap(AVAudioSession.InterruptionType.init) == .ended else { return }
          try? AVAudioSession.sharedInstance().setActive(true)
          self.player?.play()
        }
      NSLog("AudioKeepalive: started")
    } catch {
      NSLog("AudioKeepalive: start failed: \(error)")
    }
  }

  func stop() {
    guard isRunning else { return }
    isRunning = false
    player?.stop(); player = nil
    if let o = interruptionObserver { NotificationCenter.default.removeObserver(o) }
    interruptionObserver = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    NSLog("AudioKeepalive: stopped")
  }
}
#endif
