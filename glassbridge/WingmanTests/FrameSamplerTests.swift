import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class FrameSamplerTests: XCTestCase {

  /// Smooth gradient + a few dark blocks — compresses like a real scene, not like noise.
  static func makeImage(width: Int, height: Int) -> CGImage {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    for x in stride(from: 0, to: width, by: 4) {
      let t = CGFloat(x) / CGFloat(width)
      ctx.setFillColor(red: t, green: 0.4, blue: 1 - t, alpha: 1)
      ctx.fill(CGRect(x: x, y: 0, width: 4, height: height))
    }
    ctx.setFillColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
    for i in 0..<12 { ctx.fill(CGRect(x: 20 + i * (width / 14), y: height / 3, width: width / 30, height: height / 6)) }
    return ctx.makeImage()!
  }

  /// A JPEG carrying an EXIF orientation tag — what a real glasses/phone capture looks like on the wire.
  static func makeJPEG(width: Int, height: Int, orientation: Int) -> Data {
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, makeImage(width: width, height: height),
                               [kCGImagePropertyOrientation: orientation] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(dest))
    return out as Data
  }

  func testScaledLongestEdgeIs768AndAspectKept() {
    let out = FrameEncoder.scaled(Self.makeImage(width: 1280, height: 720), maxEdge: 768)
    XCTAssertEqual(out.width, 768); XCTAssertEqual(out.height, 432)
    let portrait = FrameEncoder.scaled(Self.makeImage(width: 720, height: 1280), maxEdge: 768)
    XCTAssertEqual(portrait.width, 432); XCTAssertEqual(portrait.height, 768)
  }

  func testScaledNeverUpscales() {
    let out = FrameEncoder.scaled(Self.makeImage(width: 500, height: 300), maxEdge: 768)
    XCTAssertEqual(out.width, 500); XCTAssertEqual(out.height, 300)
  }

  func testFrameJpegIsUnder120KBAndDecodable() throws {
    let data = try XCTUnwrap(FrameEncoder.encodeFrame(Self.makeImage(width: 1280, height: 720), maxEdge: 768))
    XCTAssertLessThanOrEqual(data.count, 120 * 1024)
    XCTAssertEqual([UInt8](data.prefix(2)), [0xFF, 0xD8])          // JPEG SOI
    let back = try XCTUnwrap(FrameEncoder.decode(data))
    XCTAssertEqual(back.width, 768); XCTAssertEqual(back.height, 432)
  }

  func testOfferRespectsCadenceAndIncrementsSeq() {
    var sent: [DeviceToCortex] = []
    let sampler = FrameSampler(config: .defaults) {
      XCTAssertFalse(Thread.isMainThread, "send must run on the sampler queue, never main")
      sent.append($0)
    }
    sampler.start()
    let t0 = Date()
    let img = Self.makeImage(width: 640, height: 360)
    for i in 0..<10 { sampler.offer(img, now: t0.addingTimeInterval(Double(i) * 0.1)) }   // 10 frames in 1 s → 1 emitted
    sampler.offer(img, now: t0.addingTimeInterval(1.75))                                    // exactly one interval later → 2nd
    sampler.offer(img, now: t0.addingTimeInterval(1.80))                                    // too soon → dropped
    sampler.drain()
    XCTAssertEqual(sent.count, 2)
    guard case let .frame(seq1, ts1, b64) = sent[0], case let .frame(seq2, _, _) = sent[1] else { return XCTFail() }
    XCTAssertEqual(seq1, 1); XCTAssertEqual(seq2, 2)
    XCTAssertEqual(ts1, Int64(t0.timeIntervalSince1970 * 1000))
    XCTAssertNotNil(Data(base64Encoded: b64))
  }

  func testApplyConfigChangesCadenceAndEdge() {
    var sent: [DeviceToCortex] = []
    let sampler = FrameSampler(config: .defaults) { sent.append($0) }
    sampler.apply(ArmedConfig(frameIntervalMs: 500, frameMaxEdgePx: 256, docMaxEdgePx: 1024, renderMinGapMs: 500))
    sampler.start()
    let t0 = Date(); let img = Self.makeImage(width: 1280, height: 720)
    sampler.offer(img, now: t0); sampler.offer(img, now: t0.addingTimeInterval(0.5)); sampler.drain()
    XCTAssertEqual(sent.count, 2)
    guard case let .frame(_, _, b64) = sent[0], let d = Data(base64Encoded: b64), let img2 = FrameEncoder.decode(d) else { return XCTFail() }
    XCTAssertEqual(img2.width, 256)
  }

  func testStoppedSamplerDropsFrames() {
    var sent: [DeviceToCortex] = []
    let sampler = FrameSampler { sent.append($0) }
    sampler.offer(Self.makeImage(width: 64, height: 64)); sampler.drain()
    XCTAssertTrue(sent.isEmpty)
  }

  func testStopAfterStartDropsFrames() {
    var sent: [DeviceToCortex] = []
    let sampler = FrameSampler { sent.append($0) }
    sampler.start(); sampler.stop()
    sampler.offer(Self.makeImage(width: 64, height: 64)); sampler.drain()
    XCTAssertTrue(sent.isEmpty)
    XCTAssertFalse(sampler.isRunning)
  }

  func testDownsampledAppliesExifOrientation() throws {
    // Orientation 6 = rotate 90° CW for display, so a stored 400×200 landscape is really a 200×400 portrait.
    let data = Self.makeJPEG(width: 400, height: 200, orientation: 6)
    let raw = try XCTUnwrap(FrameEncoder.decode(data))
    XCTAssertEqual(raw.width, 400); XCTAssertEqual(raw.height, 200)   // decode() ignores the tag — the bug being fixed
    let out = try XCTUnwrap(FrameEncoder.downsampled(data, maxEdge: 2048))
    XCTAssertEqual(out.width, 200); XCTAssertEqual(out.height, 400)   // downsampled() bakes the transform in
  }

  func testHandlePhotoDownscalesToDocEdgeAndEmitsPhoto() throws {
    var sent: [DeviceToCortex] = []
    let sampler = FrameSampler { sent.append($0) }
    let big = try XCTUnwrap(FrameEncoder.jpeg(Self.makeImage(width: 3024, height: 4032), quality: 0.9))
    sampler.handlePhoto(reqId: "r_18", data: big); sampler.drain()
    guard case let .photo(reqId, b64) = sent.first, let d = Data(base64Encoded: b64), let img = FrameEncoder.decode(d) else { return XCTFail() }
    XCTAssertEqual(reqId, "r_18"); XCTAssertEqual(img.height, 2048); XCTAssertEqual(img.width, 1536)
  }

  func testHandlePhotoWithGarbageEmitsPhotoError() {
    var sent: [DeviceToCortex] = []
    let sampler = FrameSampler { sent.append($0) }
    sampler.handlePhoto(reqId: "r_19", data: Data([1, 2, 3])); sampler.drain()
    XCTAssertEqual(sent.first, .photoError(reqId: "r_19", reason: "decode_failed"))
  }
}
