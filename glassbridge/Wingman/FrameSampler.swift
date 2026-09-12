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

  /// Decode straight to ≤ maxEdge. Two reasons this is not decode() + scaled() for photos:
  /// a 12 MP capture is never materialized at full size (ImageIO scales while decoding), and
  /// `WithTransform` bakes in the EXIF orientation tag — otherwise Cortex gets sideways documents,
  /// because a raw CGImage carries no orientation and jpeg() cannot re-attach one.
  static func downsampled(_ data: Data, maxEdge: Int) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(src, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: maxEdge,
      kCGImageSourceCreateThumbnailWithTransform: true,
    ] as CFDictionary)
  }
}

/// `@unchecked Sendable`: every mutable field is touched only inside `queue`, so the DAT listener thread can
/// hold a reference and call `offer` directly (its callbacks are `@Sendable`).
final class FrameSampler: @unchecked Sendable {
  // All mutable state is owned by `queue`; the underscored vars are only ever touched inside it.
  private var _config: ArmedConfig
  private var _seq = 0
  private var _isRunning = false
  private let send: (DeviceToCortex) -> Void
  private let queue = DispatchQueue(label: "wingman.framesampler", qos: .userInitiated)
  private var lastEmit = Date.distantPast

  // Read-only snapshots, hopped onto the sampler queue so callers on any thread see consistent values.
  // These and drain() must NEVER be called from inside the `send` closure — send already runs on the
  // sampler queue, so a queue.sync from there deadlocks. Read `config`/`seq` before or after, not during.
  var config: ArmedConfig { queue.sync { _config } }
  var seq: Int { queue.sync { _seq } }
  var isRunning: Bool { queue.sync { _isRunning } }

  init(config: ArmedConfig = .defaults, send: @escaping (DeviceToCortex) -> Void) {
    self._config = config
    self.send = send
  }

  /// Server-authoritative override (armed.config). Takes effect for the next frame.
  func apply(_ config: ArmedConfig) { queue.async { self._config = config } }

  func start() { queue.async { self._isRunning = true; self.lastEmit = .distantPast } }
  func stop() { queue.async { self._isRunning = false } }

  /// Offer every incoming frame; at most one per frameIntervalMs is encoded and sent, the rest are dropped.
  /// Encoding happens on the sampler queue — never on the caller's (DAT) thread or main.
  func offer(_ image: CGImage, now: Date = Date()) {
    queue.async {
      guard self._isRunning,
            now.timeIntervalSince(self.lastEmit) * 1000 >= Double(self._config.frameIntervalMs) else { return }
      self.lastEmit = now
      guard let data = FrameEncoder.encodeFrame(image, maxEdge: self._config.frameMaxEdgePx) else { return }
      self._seq += 1
      self.send(.frame(seq: self._seq, ts: Int64(now.timeIntervalSince1970 * 1000), dataBase64: data.base64EncodedString()))
    }
  }

  /// Full-res capture from DAT → ≤ docMaxEdgePx, JPEG q≈0.8 → `photo` (DESIGN.md §4.2); undecodable → `photo_error`.
  /// Downsamples straight from the JPEG bytes so the full-res bitmap is never materialized and EXIF orientation survives.
  func handlePhoto(reqId: String, data: Data) {
    queue.async {
      guard let img = FrameEncoder.downsampled(data, maxEdge: self._config.docMaxEdgePx) else {
        return self.send(.photoError(reqId: reqId, reason: "decode_failed"))
      }
      guard let out = FrameEncoder.jpeg(img, quality: 0.8) else {
        return self.send(.photoError(reqId: reqId, reason: "encode_failed"))
      }
      self.send(.photo(reqId: reqId, dataBase64: out.base64EncodedString()))
    }
  }

  func photoFailed(reqId: String, reason: String) { queue.async { self.send(.photoError(reqId: reqId, reason: reason)) } }

  /// Test/diagnostic helper: block until queued work is done.
  func drain() { queue.sync {} }
}
