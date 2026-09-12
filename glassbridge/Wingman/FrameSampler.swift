// FrameSampler.swift — DESIGN.md §5.1 responsibility 2 (sample + downscale + JPEG) and 3 (photo downscale).
// Platform-neutral: CoreGraphics + ImageIO only, so it is unit-tested on macOS.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator — emits armed.config from shared/src/constants.ts deviceConfig()
// CONTRACT: DESIGN.md §4.2 frame/photo/photo_error messages; Appendix D frameIntervalMs / frameMaxEdgePx / docMaxEdgePx
// AT-INTEGRATION: verify the received armed.config overrides the compiled defaults — BridgeController logs "config: compiled=… received=…" on every armed; confirm cadence changes after editing shared/constants.ts + redeploy.
//
// INTEGRATION: FrameSampler
// IN:  offer(CGImage) for EVERY decoded glasses frame (DATSessionManager.onFrame, off-main); handlePhoto(reqId:data:) with the
//      full-res JPEG from DAT photoDataPublisher; apply(ArmedConfig) from BridgeController on `armed`
// OUT: send(DeviceToCortex) — .frame at most once per frameIntervalMs, .photo / .photoError — invoked on the sampler's serial queue
// WIRE: FrameSampler(send: { socket.send($0) }); dat.onFrame = { sampler.offer($0) }

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum FrameEncoder {
  /// Downscale so the longest edge ≤ maxEdge. Never upscales.
  static func scaled(_ image: CGImage, maxEdge: Int) -> CGImage {
    let w = image.width, h = image.height
    let longest = max(w, h)
    guard longest > maxEdge, maxEdge > 0 else { return image }
    let s = Double(maxEdge) / Double(longest)
    let nw = max(1, Int((Double(w) * s).rounded())), nh = max(1, Int((Double(h) * s).rounded()))
    guard let ctx = CGContext(data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { return image }
    ctx.interpolationQuality = .medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: nw, height: nh))
    return ctx.makeImage() ?? image
  }

  static func jpeg(_ image: CGImage, quality: Double) -> Data? {
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return out as Data
  }

  /// DESIGN.md §4.2: longest edge ≤ frameMaxEdgePx, JPEG q≈0.6, target ≤ 120 KB.
  static func encodeFrame(_ image: CGImage, maxEdge: Int, quality: Double = 0.6) -> Data? {
    jpeg(scaled(image, maxEdge: maxEdge), quality: quality)
  }

  static func decode(_ data: Data) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
  }
}

final class FrameSampler {
  private(set) var config: ArmedConfig
  private(set) var seq = 0
  private(set) var isRunning = false
  private let send: (DeviceToCortex) -> Void
  private let queue = DispatchQueue(label: "wingman.framesampler", qos: .userInitiated)
  private var lastEmit = Date.distantPast

  init(config: ArmedConfig = .defaults, send: @escaping (DeviceToCortex) -> Void) {
    self.config = config
    self.send = send
  }

  /// Server-authoritative override (armed.config). Takes effect for the next frame.
  func apply(_ config: ArmedConfig) { queue.async { self.config = config } }

  func start() { queue.async { self.isRunning = true; self.lastEmit = .distantPast } }
  func stop() { queue.async { self.isRunning = false } }

  /// Offer every incoming frame; at most one per frameIntervalMs is encoded and sent, the rest are dropped.
  /// Encoding happens on the sampler queue — never on the caller's (DAT) thread or main.
  func offer(_ image: CGImage, now: Date = Date()) {
    queue.async {
      guard self.isRunning,
            now.timeIntervalSince(self.lastEmit) * 1000 >= Double(self.config.frameIntervalMs) else { return }
      self.lastEmit = now
      guard let data = FrameEncoder.encodeFrame(image, maxEdge: self.config.frameMaxEdgePx) else { return }
      self.seq += 1
      self.send(.frame(seq: self.seq, ts: Int64(now.timeIntervalSince1970 * 1000), dataBase64: data.base64EncodedString()))
    }
  }

  /// Full-res capture from DAT → ≤ docMaxEdgePx, JPEG q≈0.8 → `photo` (DESIGN.md §4.2); undecodable → `photo_error`.
  func handlePhoto(reqId: String, data: Data) {
    queue.async {
      guard let img = FrameEncoder.decode(data) else { return self.send(.photoError(reqId: reqId, reason: "decode_failed")) }
      guard let out = FrameEncoder.encodeFrame(img, maxEdge: self.config.docMaxEdgePx, quality: 0.8) else {
        return self.send(.photoError(reqId: reqId, reason: "encode_failed"))
      }
      self.send(.photo(reqId: reqId, dataBase64: out.base64EncodedString()))
    }
  }

  func photoFailed(reqId: String, reason: String) { queue.async { self.send(.photoError(reqId: reqId, reason: reason)) } }

  /// Test/diagnostic helper: block until queued work is done.
  func drain() { queue.sync {} }
}
