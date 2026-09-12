// HEVCFrameDecoder.swift — decompresses the hvc1 CMSampleBuffers DAT streams into CGImages.
//
// ADAPTED FROM Meta's own sample decoder:
//   samples/CameraAccess/CameraAccess/Media/VideoFrameDecoder.swift
//   https://github.com/facebook/meta-wearables-dat-ios   (Copyright (c) Meta Platforms, Inc. and affiliates)
// Changes from the sample: returns CGImage? (not UIImage) for FrameSampler, and on a decode miss it
// returns nil instead of replaying the last good frame — a sampler wants no frame, not a duplicate one.
//
// INTEGRATION: HEVCFrameDecoder
// IN:  compressed HEVC CMSampleBuffers from DATSessionManager.cgImage(from:), off-main, one at a time
// OUT: CGImage? — nil while waiting for the first keyframe after (re)creating the session, or on failure
// WIRE: one file-scope instance in DATSessionManager.swift. No DAT types here, so this file also builds
//       in the macOS SwiftPM slice (VideoToolbox/CoreMedia/CoreImage only, no UIKit).

import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import VideoToolbox
import os

/// File-scope so every decode shares one render context (creating a CIContext per frame is expensive).
private let hevcCIContext = CIContext()

/// Thread-safe: `decode(_:)` may be called from any thread (DAT calls it from its listener thread).
final class HEVCFrameDecoder: @unchecked Sendable {
  private struct State {
    var session: VTDecompressionSession?
    var formatDescription: CMFormatDescription?
    var consecutiveFailures: Int = 0
    var awaitingKeyframe: Bool = false
  }

  private let state = OSAllocatedUnfairLock(uncheckedState: State())

  /// Decodes one HEVC sample buffer. Creates the decompression session lazily and recreates it if the
  /// format changes or it goes invalid; returns nil until a keyframe arrives after any (re)creation.
  func decode(_ sampleBuffer: CMSampleBuffer) -> CGImage? {
    guard CMSampleBufferGetDataBuffer(sampleBuffer) != nil,
          let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer)
    else { return nil }

    let isKeyframe = Self.isKeyframe(sampleBuffer)

    let (session, awaitingKeyframe) = state.withLockUnchecked { state -> (VTDecompressionSession?, Bool) in
      // Recreate if the format description changed (e.g. a resolution switch mid-stream).
      if let currentFormat = state.formatDescription,
         let existingSession = state.session,
         !CMFormatDescriptionEqual(currentFormat, otherFormatDescription: formatDescription)
      {
        VTDecompressionSessionInvalidate(existingSession)
        state.session = nil
        state.formatDescription = nil
        state.consecutiveFailures = 0
        state.awaitingKeyframe = true
      }

      if let session = state.session {
        // Catch an invalidated session before a decode attempt fails.
        if VTDecompressionSessionCanAcceptFormatDescription(session, formatDescription: formatDescription) {
          return (session, state.awaitingKeyframe)
        }
        VTDecompressionSessionInvalidate(session)
        state.session = nil
        state.formatDescription = nil
        state.consecutiveFailures = 0
        state.awaitingKeyframe = true
      }

      // Force software decoding so the session survives backgrounding. iOS tears down hardware
      // sessions when backgrounded, and a fresh one stalls until the next keyframe.
      var decoderSpec: CFDictionary?
      if #available(iOS 17.0, *) {
        decoderSpec = [
          kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder as String: false
        ] as CFDictionary
      }

      let outputAttrs: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA]

      var newSession: VTDecompressionSession?
      VTDecompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        formatDescription: formatDescription,
        decoderSpecification: decoderSpec,
        imageBufferAttributes: outputAttrs as CFDictionary,
        outputCallback: nil,
        decompressionSessionOut: &newSession)
      state.session = newSession
      state.formatDescription = formatDescription
      state.consecutiveFailures = 0
      state.awaitingKeyframe = true
      return (newSession, true)
    }

    // A fresh session cannot decode P-frames until the next keyframe — feeding it one yields garbage.
    guard let session, !(awaitingKeyframe && !isKeyframe) else { return nil }

    // The handler runs synchronously on this thread because flags is empty, so capturing this local
    // by reference is safe despite the @Sendable warning.
    // WARNING: do not add ._EnableAsynchronousDecompression (or any async flag) — the handler would
    // then run off-thread and this capture would be a data race.
    nonisolated(unsafe) var outputPixelBuffer: CVPixelBuffer?
    let decodeStatus = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: sampleBuffer,
      flags: [],
      infoFlagsOut: nil
    ) { status, _, imageBuffer, _, _ in
      if status == noErr, let imageBuffer {
        outputPixelBuffer = imageBuffer
      }
    }

    // After 3 consecutive failures, invalidate so the next frame builds a fresh session — tolerates
    // transient errors while still recovering from a persistent one (a session torn down while backgrounded).
    if decodeStatus != noErr {
      state.withLockUnchecked { state in
        state.consecutiveFailures += 1
        guard state.consecutiveFailures >= 3 else { return }
        if let session = state.session { VTDecompressionSessionInvalidate(session) }
        state.session = nil
        state.formatDescription = nil
        state.consecutiveFailures = 0
        state.awaitingKeyframe = true
      }
      return nil
    }

    state.withLockUnchecked { state in
      state.consecutiveFailures = 0
      if isKeyframe { state.awaitingKeyframe = false }
    }

    guard let pixelBuffer = outputPixelBuffer else { return nil }
    return hevcCIContext.createCGImage(
      CIImage(cvPixelBuffer: pixelBuffer),
      from: CGRect(
        x: 0, y: 0,
        width: CVPixelBufferGetWidth(pixelBuffer),
        height: CVPixelBufferGetHeight(pixelBuffer)))
  }

  /// Sync sample (IDR) unless the attachments explicitly say otherwise — the sample decoder's
  /// `isHEVCKeyframe()` helper, inlined.
  private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[CFString: Any]],
          let first = attachments.first
    else { return true }
    return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
  }
}
