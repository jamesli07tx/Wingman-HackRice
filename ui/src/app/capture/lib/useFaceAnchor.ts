"use client";

// INTEGRATION: capture/useFaceAnchor
// IN:  the live <video> element + the overlay container box
// OUT: { cx, aboveY, belowY, mode } in container CSS pixels — where ArBubble anchors itself
// WIRE: page.tsx passes the refs; ArBubble consumes the returned anchor.
//
// PRIVACY (DESIGN.md D5 — normative, not a nicety):
// Face DETECTION runs entirely on this device, in the browser, via MediaPipe tasks-vision.
// It is used for ONE thing: choosing an (x, y) on screen to float the bubble above.
// Nothing derived from a face ever leaves the device — no crops, no embeddings, no boxes,
// no counts are put on the wire, and Cortex has no face code at all. There is no facial
// recognition and no person-level identification anywhere in Wingman; identification is
// company-level only, from booth signage. The frames that DO leave the device are the
// protocol's sampled JPEGs (FrameMsg), which are unrelated to this detector's output.

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Detection, FaceDetector } from "@mediapipe/tasks-vision";
import { coverBox } from "./imaging";

/** Pinned so the wasm bundle and the JS package cannot drift (MediaPipe docs pattern). */
const TASKS_VISION_VERSION = "0.10.35"; // keep in sync with console/package.json
const WASM_CDN_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

const DETECT_INTERVAL_MS = 200;
/** Faces smaller than this fraction of the frame's longest edge are ignored as background. */
const MIN_FACE_FRACTION = 0.06;

export type AnchorMode = "face" | "fallback";

export interface BubbleAnchor {
  /** horizontal center, container CSS px */
  cx: number;
  /** y of the top edge of the anchor target (bubble prefers to sit above this) */
  aboveY: number;
  /** y of the bottom edge of the anchor target (bubble falls below when there is no room) */
  belowY: number;
  mode: AnchorMode;
}

export type FaceModelStatus = "idle" | "loading" | "ready" | "unavailable";

export interface FaceAnchorResult {
  anchor: BubbleAnchor;
  modelStatus: FaceModelStatus;
  faceVisible: boolean;
}

function fallbackAnchor(w: number, h: number): BubbleAnchor {
  // Graceful fallback (no face in view, model still loading, or model unavailable):
  // upper-center of the viewport, the same place the glasses HUD lives.
  return { cx: w / 2, aboveY: h * 0.3, belowY: h * 0.12, mode: "fallback" };
}

export function useFaceAnchor(
  videoRef: RefObject<HTMLVideoElement | null>,
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): FaceAnchorResult {
  const [anchor, setAnchor] = useState<BubbleAnchor>(() => fallbackAnchor(0, 0));
  const [modelStatus, setModelStatus] = useState<FaceModelStatus>("idle");
  const [faceVisible, setFaceVisible] = useState(false);
  const detectorRef = useRef<FaceDetector | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastTs = 0;
    let missStreak = 0;

    const measure = (): { w: number; h: number } => {
      const el = containerRef.current;
      if (!el) return { w: 0, h: 0 };
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    };

    const tick = (): void => {
      const video = videoRef.current;
      const detector = detectorRef.current;
      const { w, h } = measure();
      if (!video || video.videoWidth === 0 || w === 0 || h === 0) return;
      if (!detector) {
        setAnchor(fallbackAnchor(w, h));
        return;
      }

      let ts = performance.now();
      if (ts <= lastTs) ts = lastTs + 1; // MediaPipe requires strictly increasing timestamps
      lastTs = ts;

      let detections: Detection[];
      try {
        detections = detector.detectForVideo(video, ts).detections;
      } catch {
        // A single bad inference must never take the page down: drop to fallback.
        setAnchor(fallbackAnchor(w, h));
        return;
      }

      const minEdge = MIN_FACE_FRACTION * Math.max(video.videoWidth, video.videoHeight);
      let best: { x: number; y: number; w: number; h: number } | null = null;
      let bestArea = 0;
      for (const d of detections) {
        const bb = d.boundingBox;
        if (!bb) continue;
        if (Math.max(bb.width, bb.height) < minEdge) continue;
        const area = bb.width * bb.height;
        // "Nearest" face == largest box in frame.
        if (area > bestArea) {
          bestArea = area;
          best = { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height };
        }
      }

      if (!best) {
        missStreak += 1;
        // A couple of dropped frames should not make the bubble jump; only fall back
        // after the face has really been gone for ~0.6 s.
        if (missStreak >= 3) {
          setFaceVisible(false);
          setAnchor(fallbackAnchor(w, h));
        }
        return;
      }
      missStreak = 0;
      setFaceVisible(true);

      const box = coverBox(video.videoWidth, video.videoHeight, w, h);
      const cx = box.offsetX + (best.x + best.w / 2) * box.scale;
      const top = box.offsetY + best.y * box.scale;
      const bottom = top + best.h * box.scale;
      setAnchor({
        cx: Math.min(Math.max(cx, 8), Math.max(8, w - 8)),
        aboveY: top,
        belowY: bottom,
        mode: "face",
      });
    };

    const load = async (): Promise<void> => {
      setModelStatus("loading");
      try {
        // Lazy-loaded: the page (camera + WS + frame sampling) is fully functional
        // before MediaPipe is even fetched.
        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_CDN_ROOT);
        const detector = await vision.FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          minDetectionConfidence: 0.5,
        });
        if (cancelled) {
          detector.close();
          return;
        }
        detectorRef.current = detector;
        setModelStatus("ready");
      } catch {
        // No CDN, no WebGL, offline — the bubble simply pins upper-center.
        if (!cancelled) setModelStatus("unavailable");
      }
    };

    void load();
    timer = setInterval(tick, DETECT_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
      const d = detectorRef.current;
      detectorRef.current = null;
      if (d) {
        try {
          d.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [active, videoRef, containerRef]);

  return { anchor, modelStatus, faceVisible };
}
