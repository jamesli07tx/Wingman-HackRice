"use client";

// INTEGRATION: capture/useCamera
// IN:  nothing (browser getUserMedia, rear camera preferred)
// OUT: a ready <video> element playing the live MediaStream — the source for both the
//      frame sampler (FrameMsg) and the client-side face detector (D5)
// WIRE: page.tsx calls useCamera(videoRef); the stream itself never leaves the device
//       except as the downscaled JPEGs the protocol defines.

import { useEffect, useState, type RefObject } from "react";

export type CameraStatus = "idle" | "starting" | "ready" | "denied" | "unsupported" | "failed";

export interface CameraState {
  status: CameraStatus;
  error: string | null;
  /** intrinsic stream dimensions, once known */
  width: number;
  height: number;
}

export function useCamera(videoRef: RefObject<HTMLVideoElement | null>): CameraState {
  const [state, setState] = useState<CameraState>({
    status: "idle",
    error: null,
    width: 0,
    height: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    const start = async (): Promise<void> => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setState((s) => ({ ...s, status: "unsupported", error: "getUserMedia unavailable" }));
        return;
      }
      setState((s) => ({ ...s, status: "starting", error: null }));
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Rear camera; `ideal` (not `exact`) so laptops/desktops still work for dev.
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false, // there is no audio path anywhere in Wingman (v2).
        });
      } catch (err) {
        if (cancelled) return;
        const name = err instanceof DOMException ? err.name : "";
        setState((s) => ({
          ...s,
          status: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed",
          error: err instanceof Error ? err.message : String(err),
        }));
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        setState((s) => ({ ...s, status: "failed", error: "video element missing" }));
        return;
      }
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      try {
        await video.play();
      } catch {
        /* autoplay can reject before a gesture; the metadata handler still fires */
      }
      const markReady = (): void => {
        if (cancelled) return;
        setState({
          status: "ready",
          error: null,
          width: video.videoWidth,
          height: video.videoHeight,
        });
      };
      if (video.readyState >= 2 && video.videoWidth > 0) markReady();
      else video.addEventListener("loadedmetadata", markReady, { once: true });
    };

    void start();

    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [videoRef]);

  return state;
}
