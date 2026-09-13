"use client";

// INTEGRATION: Console /capture — phone-mode device adapter (DESIGN.md §5.2, D2)
// IN:   CortexToDeviceMsg over the device WebSocket
//       (wss://$NEXT_PUBLIC_CORTEX_WS_URL/ws/device?token=<deviceToken>) —
//       armed{config?} · capture_photo{reqId,quality} · render{card:HudCard} ·
//       session_end{reason} · error{code,message,recoverable}
// OUT:  DeviceToCortexMsg on the same socket —
//       hello{deviceType:"phone_web",caps} · session_start · frame{seq,ts,mime,dataBase64} ·
//       photo{reqId,...} / photo_error{reqId,reason} · status{battery?,note?} · session_stop
// WIRE: this page is the console-side twin of glassbridge (Swift). Same protocol, same
//       responsibilities (link → session plumbing → obey Cortex → show status), different
//       camera and different renderer. DESIGN.md §4.2 is the only copy of the contract;
//       Cortex needs no phone-specific branch — it sees one more device adapter.
//       Zero product logic lives here: no triggers, no buttons, no rotation timing (D3, D11).
//
// PRIVACY (D5): MediaPipe face detection runs client-side only, purely to anchor the bubble.
// Nothing derived from a face is ever sent anywhere — see lib/useFaceAnchor.ts.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import type { ArmedConfig, CapturePhotoMsg, DeviceToCortexMsg } from "@wingman/shared";
import { deviceConfig } from "@wingman/shared";
import { ArBubble } from "./components/ArBubble";
import { HudReplica } from "./components/HudReplica";
import { StatusChip } from "./components/StatusChip";
import { base64Bytes, captureJpegBase64 } from "./lib/imaging";
import { useCamera } from "./lib/useCamera";
import { useCardPresenter } from "./lib/useCardPresenter";
import { useDeviceLink } from "./lib/useDeviceLink";
import { useFaceAnchor } from "./lib/useFaceAnchor";

const FRAME_JPEG_QUALITY = 0.6; // DESIGN.md §4.2 frame spec
const PHOTO_JPEG_QUALITY = 0.8; // DESIGN.md §4.2 document photo spec
const DEV_TOGGLE_KEY = "wingman.capture.hudReplica";

export default function CapturePage() {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const photoCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const seqRef = useRef(0);
  const sendRef = useRef<(msg: DeviceToCortexMsg) => boolean>(() => false);
  const configRef = useRef<ArmedConfig>(deviceConfig());

  const [framesSent, setFramesSent] = useState(0);
  const [lastFrameKb, setLastFrameKb] = useState(0);
  const [hudReplica, setHudReplica] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const camera = useCamera(videoRef);
  const presenter = useCardPresenter();

  // --- Cortex asks for a full-res document photo (DESIGN.md §4.2 capture_photo) -----------
  const handleCapturePhoto = useCallback((msg: CapturePhotoMsg) => {
    const video = videoRef.current;
    const canvas = photoCanvasRef.current;
    try {
      if (!video || !canvas || video.videoWidth === 0) throw new Error("camera not ready");
      const dataBase64 = captureJpegBase64(
        video,
        canvas,
        configRef.current.docMaxEdgePx,
        PHOTO_JPEG_QUALITY,
      );
      if (!dataBase64) throw new Error("jpeg encode failed");
      const ok = sendRef.current({ type: "photo", reqId: msg.reqId, mime: "image/jpeg", dataBase64 });
      if (!ok) throw new Error("socket closed");
    } catch (err) {
      sendRef.current({
        type: "photo_error",
        reqId: msg.reqId,
        reason: err instanceof Error ? err.message : "capture_failed",
      });
    }
  }, []);

  const link = useDeviceLink({
    enabled: isLoaded && isSignedIn === true,
    getToken,
    onRender: presenter.present,
    onCapturePhoto: handleCapturePhoto,
  });

  sendRef.current = link.send;
  configRef.current = link.state.config;

  const { armed, config } = link.state;
  const cameraReady = camera.status === "ready";

  // --- Frame sampler: the only thing this page does on its own (D3 — no triggers) ---------
  useEffect(() => {
    if (!armed || !cameraReady) return;
    const tick = (): void => {
      const video = videoRef.current;
      const canvas = frameCanvasRef.current;
      if (!video || !canvas || document.visibilityState === "hidden") return;
      const dataBase64 = captureJpegBase64(
        video,
        canvas,
        config.frameMaxEdgePx,
        FRAME_JPEG_QUALITY,
      );
      if (!dataBase64) return;
      seqRef.current += 1;
      const ok = sendRef.current({
        type: "frame",
        seq: seqRef.current,
        ts: Date.now(),
        mime: "image/jpeg",
        dataBase64,
      });
      if (ok) {
        setFramesSent((n) => n + 1);
        setLastFrameKb(Math.round(base64Bytes(dataBase64) / 1024));
      }
    };
    const id = setInterval(tick, Math.max(250, config.frameIntervalMs));
    tick();
    return () => clearInterval(id);
  }, [armed, cameraReady, config.frameIntervalMs, config.frameMaxEdgePx]);

  // --- Overlay geometry -------------------------------------------------------------------
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const update = (): void => {
      const r = el.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // --- Dev toggle persistence (the only control on the page besides Restart) --------------
  useEffect(() => {
    try {
      setHudReplica(window.localStorage.getItem(DEV_TOGGLE_KEY) === "1");
    } catch {
      /* private mode */
    }
  }, []);
  const toggleReplica = useCallback(() => {
    setHudReplica((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(DEV_TOGGLE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const face = useFaceAnchor(videoRef, overlayRef, cameraReady && !hudReplica);

  const cameraNote = useMemo(() => {
    switch (camera.status) {
      case "denied":
        return "Camera permission denied — allow it and reload.";
      case "unsupported":
        return "This browser cannot open a camera (needs HTTPS + getUserMedia).";
      case "failed":
        return `Camera failed: ${camera.error ?? "unknown"}`;
      case "starting":
      case "idle":
        return "Starting camera…";
      default:
        return null;
    }
  }, [camera.status, camera.error]);

  const ended = link.state.status === "ended";

  if (isLoaded && isSignedIn === false) {
    return (
      <Shell>
        <Centered
          title="Sign in to start phone mode"
          body="Phone mode claims a device against your Wingman account, so it needs a signed-in session."
          action={{ label: "Go to home", href: "/" }}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      {/* full-bleed rear-camera preview */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          background: "#000",
          // Never display:none — a hidden <video> can stop decoding on mobile and the frame
          // sampler must keep working while the HUD replica overlay covers it.
        }}
      />

      <canvas ref={frameCanvasRef} style={{ display: "none" }} />
      <canvas ref={photoCanvasRef} style={{ display: "none" }} />

      {/* overlay layer — the bubble is positioned inside this box */}
      <div ref={overlayRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        {!hudReplica && presenter.card ? (
          <ArBubble
            card={presenter.card}
            anchor={face.anchor}
            containerWidth={box.w}
            containerHeight={box.h}
          />
        ) : null}

        {hudReplica ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "#05070a",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "12px",
              gap: 12,
            }}
          >
            <div
              style={{
                color: "#7d8894",
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                textAlign: "center",
              }}
            >
              600 × 600 lens replica · glasses renderer contract
            </div>
            <HudReplica card={presenter.card} idleNote="Wingman armed — looking for a banner" />
          </div>
        ) : null}

        <StatusChip
          status={link.state.status}
          armed={armed}
          configSource={link.state.configSource}
          cameraNote={cameraNote}
          localError={link.state.localError}
          lastError={link.state.lastError}
          framesSent={framesSent}
        />

        {/* dev toggle — small, corner, the page's only routine control (D3: no triggers) */}
        <button
          type="button"
          onClick={toggleReplica}
          aria-pressed={hudReplica}
          style={{
            position: "absolute",
            right: 10,
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 10px)",
            padding: "7px 11px",
            borderRadius: 999,
            border: `1px solid ${hudReplica ? "#5ad1ff88" : "rgba(255,255,255,0.16)"}`,
            background: "rgba(11,14,19,0.7)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            color: hudReplica ? "#5ad1ff" : "#c8d1da",
            fontSize: 11.5,
            lineHeight: 1,
            zIndex: 30,
          }}
        >
          HUD replica {hudReplica ? "on" : "off"}
        </button>

        {/* tiny telemetry readout, bottom-left */}
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)",
            color: "rgba(255,255,255,0.45)",
            fontSize: 10.5,
            lineHeight: 1.4,
            fontVariantNumeric: "tabular-nums",
            pointerEvents: "none",
            zIndex: 30,
          }}
        >
          {config.frameIntervalMs} ms · {config.frameMaxEdgePx}px · {lastFrameKb} KB
          <br />
          face: {face.modelStatus}
          {face.modelStatus === "ready" ? (face.faceVisible ? " · anchored" : " · centered") : " · centered"}
        </div>

        {ended ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(5,7,10,0.84)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 40,
            }}
          >
            <Centered
              title={
                link.state.endReason === "error" ? "Session ended (error)" : "Session ended"
              }
              body="Cortex closed this session. Nothing is being captured or sent."
              action={{ label: "Start a new session", onClick: link.restart }}
            />
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        overflow: "hidden",
        fontFamily:
          'ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif',
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <style>{`
        @keyframes wm-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.35; transform: scale(0.82); }
        }
      `}</style>
      {children}
    </main>
  );
}

interface CenteredAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

function Centered({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: CenteredAction;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: 28,
        textAlign: "center",
        color: "#e6ebf1",
      }}
    >
      <div style={{ fontSize: 19, fontWeight: 650, letterSpacing: "-0.01em" }}>{title}</div>
      <div style={{ fontSize: 13.5, color: "#9aa6b2", maxWidth: 320, lineHeight: 1.5 }}>{body}</div>
      {action ? (
        action.href ? (
          <a
            href={action.href}
            style={{
              marginTop: 8,
              padding: "9px 16px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.18)",
              color: "#e6ebf1",
              fontSize: 13,
              textDecoration: "none",
            }}
          >
            {action.label}
          </a>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            style={{
              marginTop: 8,
              padding: "9px 16px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
              color: "#e6ebf1",
              fontSize: 13,
            }}
          >
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}
