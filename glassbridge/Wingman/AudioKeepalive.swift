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
import UIKit

final class AudioKeepalive {
  private(set) var isRunning = false
  private var player: AVAudioPlayer?
  private var observers: [NSObjectProtocol] = []
  /// Set on interruption .began; some interruptions never deliver .ended, so foregrounding also clears it.
  private var interrupted = false

  func start() {
    guard !isRunning else { return }
    do {
      try makePlayer()
      isRunning = true
      observe()
      NSLog("AudioKeepalive: started")
    } catch {
      // setActive(true) may already have succeeded before the player threw — don't leave the session held.
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      NSLog("AudioKeepalive: start failed: \(error)")
    }
  }

  func stop() {
    guard isRunning else { return }
    isRunning = false
    interrupted = false
    player?.stop(); player = nil
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    NSLog("AudioKeepalive: stopped")
  }

  /// Category + active session + a fresh looping player. Used by start() and by media-reset recovery,
  /// which invalidates every previously created AVAudioSession/AVAudioPlayer object.
  private func makePlayer() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
    try session.setActive(true)
    let p = try AVAudioPlayer(contentsOf: SilentWav.url())
    p.numberOfLoops = -1
    p.volume = 1.0            // the file itself is silent; volume 0 can get the session deprioritized
    p.prepareToPlay()
    p.play()
    player = p
  }

  private func resume() {
    interrupted = false
    try? AVAudioSession.sharedInstance().setActive(true)
    player?.play()
  }

  private func observe() {
    let nc = NotificationCenter.default
    // Phone call / Siri pauses us silently otherwise — restart when the interruption ends.
    observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      guard let self, self.isRunning else { return }
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      let type = raw.flatMap(AVAudioSession.InterruptionType.init)
      if type == .began { self.interrupted = true } else if type == .ended { self.resume() }
    })
    // Media services reset invalidates the player permanently while isRunning stays true — rebuild from scratch.
    observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, self.isRunning else { return }
      self.player?.stop(); self.player = nil
      do { try self.makePlayer(); NSLog("AudioKeepalive: rebuilt after media services reset") }
      catch { NSLog("AudioKeepalive: media-services rebuild failed: \(error)") }
    })
    // Safety net for an interruption whose .ended never arrives (another app kept the session).
    observers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, self.isRunning, self.interrupted else { return }
      self.resume()
    })
  }
}
#endif
