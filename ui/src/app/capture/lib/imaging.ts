// INTEGRATION: capture/imaging
// IN:  a live <video> element bound to the rear-camera MediaStream
// OUT: base64 JPEG payloads for FrameMsg (<= frameMaxEdgePx, q~0.6) and
//      PhotoMsg (<= docMaxEdgePx, q~0.8) — DESIGN.md §4.2 + D7 ("downscaled client-side")
// WIRE: page.tsx calls captureJpegBase64() on the sampler interval and on capture_photo.

/** Longest-edge-bounded draw. Returns the base64 body (no `data:` prefix) or null. */
export function captureJpegBase64(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maxEdge: number,
  quality: number,
): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw <= 0 || vh <= 0) return null;

  const scale = Math.min(1, maxEdge / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const body = dataUrl.slice(comma + 1);
  return body.length > 0 ? body : null;
}

/** Rough wire size of a base64 payload, for the debug readout. */
export function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

/**
 * Geometry of a `object-fit: cover` video inside its container, in CSS pixels.
 * Needed to map MediaPipe detections (intrinsic video coords) to overlay coords.
 */
export interface CoverBox {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function coverBox(
  videoW: number,
  videoH: number,
  containerW: number,
  containerH: number,
): CoverBox {
  if (videoW <= 0 || videoH <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.max(containerW / videoW, containerH / videoH);
  return {
    scale,
    offsetX: (containerW - videoW * scale) / 2,
    offsetY: (containerH - videoH * scale) / 2,
  };
}
