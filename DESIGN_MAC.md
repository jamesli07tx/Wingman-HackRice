# Wingman — Mac Build Plan (DESIGN_MAC.md)

**You are the agent on the Mac.** You implement this file. DESIGN.md (v2) is the normative spec for everything you build; DESIGN_WINDOWS.md describes what the other agent — on a separate Windows laptop, with whom you cannot communicate — is building in parallel. Read all three, implement only what this file assigns you.

---

## 0. Merge contract (identical section in DESIGN_WINDOWS.md — the rules that make a clash impossible)

**Path ownership is absolute and disjoint.** Merging the two work products is a union of directories; a git conflict is structurally impossible if both sides obey this table:

| Path | Owner | The other side may |
|---|---|---|
| `/` root files (`pnpm-workspace.yaml`, `package.json`, `.gitignore`, `.env.example`, `README.md`, `DESIGN*.md`) | **Windows** | read only |
| `shared/` `cortex/` `console/` `corpus/` | **Windows** | read only |
| `glassbridge/` — everything inside, including `glassbridge/.gitignore`, `glassbridge/README.md`, `glassbridge/DevHarness/` | **Mac** | read only |

1. **NEVER create, modify, or delete any file outside `glassbridge/`.** Not the root `.gitignore` (put Xcode/`xcuserdata` rules in `glassbridge/.gitignore` — nested gitignores work), not `shared/` (you *read* it and DESIGN.md; you never edit them), not the design docs.
2. **The wire contract is the only interface** between the two builds: the device WebSocket (§4.2), the `/api/devices/claim` REST endpoint (§4.1), `HudCard` + renderer constraints (§4.2), and the tuning constants (Appendix D, pushed at runtime via `armed.config`). **DESIGN.md is the ONLY copy of that contract.** No contract JSON is restated in this file or DESIGN_WINDOWS.md, so there is exactly one document to drift from — and it is frozen. `Protocol.swift` is transcribed from DESIGN.md §4, never inferred from `cortex/` source.
3. **No unilateral protocol changes, ever.** If you believe a §4 / Appendix C / Appendix D change is necessary, STOP and surface it to the human. The counterpart agent cannot see your change; a "small fix" on one side is a broken demo.
4. **Lenient decoding, strict encoding.** Emit messages exactly as specified — JSON field names stay camelCase on the wire (map to Swift conventions via `CodingKeys` only). When decoding, ignore unknown fields rather than erroring (default `Codable` behavior — keep it; no strict validators).
5. **Git flow:** the shared GitHub repo already exists — `https://github.com/jamesli07tx/Wingman-HackRice`, default branch `master`, founded by the human with the design docs in it. Windows pushes the monorepo skeleton first; you clone, create `glassbridge/`, and commit only inside it. Both push to `master` freely — disjoint paths mean no conflicts. (Offline fallback: your `glassbridge/` folder is copied into the repo root by USB/AirDrop; same result.)
6. **Integration-day sequence** (human-driven, ~15 min): ① Windows side deploys Cortex → human gets the `wss://…fly.dev` URL. ② Human sets it in `glassbridge/Config.local.xcconfig`, rebuilds onto the phone. ③ Dashboard shows the 6-digit link code → typed into GlassBridge → `/api/devices/claim`. ④ Start from either end → M2 checks (DESIGN.md §6).
7. **Cross-machine integration comments are mandatory.** Beyond DESIGN.md §7's per-module `// INTEGRATION:` blocks, every point where your code touches the cross-machine seam carries a greppable block in this exact format:
   ```
   // INTEGRATION(X-MACHINE):
   // COUNTERPART: <file/component on the other machine that connects here>
   // CONTRACT: DESIGN.md §<ref> — <message/endpoint name>
   // AT-INTEGRATION: <the exact action or check for integration day — fill this value / run this check / nothing, wired automatically>
   ```
   Anything deliberately deferred to integration day is additionally marked `INTEGRATION-DAY: <exact action>` at the deferred line. The integration agent (or human) works from `grep -rn "INTEGRATION"` output plus the three design docs and nothing else — write every block so that is sufficient. Each machine doc lists its required comment sites; missing sites are a build defect, not a style issue.

---

## 1. Your scope

Exactly one product: **GlassBridge**, the Swift iOS app of DESIGN.md §5.1 — a dumb pipe with a sampler and a renderer, zero product intelligence — plus its dev harness. File layout per Appendix B, all inside `glassbridge/`:

- `Wingman.xcodeproj` / SwiftUI app target (iOS 17.2+), DAT via SPM: `facebook/meta-wearables-dat-ios` v0.9.0.
- `Protocol.swift` — hand-mirror of DESIGN.md §4.2 (all message types incl. `armed.config`, `HudCard`, `ErrorCode`) with `CodingKeys` preserving wire names.
- `Config.swift` + `Config.xcconfig` / `Config.local.xcconfig` (gitignored) — `CORTEX_URL`, `CORTEX_WS_URL`; ship placeholder values; the real URL arrives at integration (§0.6).
- `DATSessionManager.swift` — ONE `DeviceSession` with camera-stream + display capabilities.
- `FrameSampler.swift` — sample 1 frame per `frameIntervalMs`, downscale longest edge ≤ `frameMaxEdgePx`, JPEG q≈0.6, target ≤ 120 KB, emit `frame` messages. Constants: compiled defaults from Appendix D, **overridden by `armed.config` whenever present** (server is authoritative).
- `CortexSocket.swift` — WS to `…/ws/device?token=`, auto-reconnect with backoff, `session_start`/`session_stop`, `status` heartbeats.
- `HudRenderer.swift` — `HudCard` → DAT declarative components (Text/Image, FlexBox). **Full-screen replace only; coalesce renders ≥ `renderMinGapMs` (500 ms default), always drawing the latest card.** Respect the 5-lines × ~40-chars contract — never wrap-scroll; Cortex guarantees limits, you guarantee legibility (font sizes tested on-lens at M2).
- `AudioKeepalive.swift` — silent-audio lock survival per §5.1: `audio` in `UIBackgroundModes`, `AVAudioSession` `.playback` + `.mixWithOthers`, looped silent file (`numberOfLoops = -1`), restart on `interruptionNotification`, stop at session Stop.
- `StatusView.swift` — one screen: link-code entry (→ `/api/devices/claim`, token to Keychain), connection dots, Start/Stop, battery, last error.
- `DevHarness/harness.mjs` — a ~100-line Node script (plain `node`, no deps beyond `ws`): a fake Cortex that accepts your WS connection, logs/validates incoming `frame`/`photo`/`status` JSON against the shapes in DESIGN.md §4.2, and replays a scripted card sequence (`armed` with config → ack → company 1/2 → pitch 2/2 rotation → `capture_photo` → scan merge → `session_end`). This is your integration test until the real Cortex URL arrives.
- `WingmanTests/` — XCTest target: `Protocol.swift` round-trips every JSON example in DESIGN.md §4.2 (embed the doc's examples as literals), unknown-field decode tolerance, `FrameSampler` downscale math, render-coalescing timing.

### 1.1 Xcode project mechanics — you own ALL of this

- **Project:** Xcode 15+ · new iOS App target, SwiftUI lifecycle · product name `Wingman` · bundle ID `com.hackrice.wingman` (personal-team signing may force a suffix — accept whatever Xcode settles on; it's local-only) · **minimum deployment iOS 17.2** (DAT requirement). Check the `.xcodeproj` in; keep `xcuserdata/`, `DerivedData`, `Config.local.xcconfig` out via `glassbridge/.gitignore`.
- **Dependency:** File → Add Package Dependencies → `https://github.com/facebook/meta-wearables-dat-ios`, pinned **exactly 0.9.0** (Package.resolved is committed — both a build reproducibility and a "no surprise upgrades mid-hackathon" rule).
- **Signing:** Automatically manage signing · Team = the free Personal Team (Apple ID added in Xcode Settings → Accounts). Free provisioning: installs expire in 7 days (re-sign demo morning, DESIGN.md §8), max 3 sideloaded apps, device must be plugged in for install.
- **Capabilities:** Signing & Capabilities → + Background Modes → check **Audio, AirPlay, and Picture in Picture** (this is the keepalive's `UIBackgroundModes: audio`). No other capabilities — no push, no VoIP, no location.
- **Info.plist:**
  - `NSBluetoothAlwaysUsageDescription` — "Wingman connects to your Meta glasses." (DAT transport)
  - `NSLocalNetworkUsageDescription` — "Wingman streams from your Meta glasses." (+ `NSBonjourServices` entries only if the DAT integration guide names them — follow its setup page verbatim)
  - **No** `NSMicrophoneUsageDescription` (D1: no mic — adding it would contradict the privacy story) and no phone-camera permission (the phone camera is never used; the glasses camera comes via DAT).
  - App Transport Security: add `NSAllowsLocalNetworking = true` **only** so `ws://localhost` reaches DevHarness in Debug; production traffic is `wss://` and needs no exception. Prefer scoping this to the Debug configuration via the xcconfig split.
- **Config split:** `Config.xcconfig` (committed, placeholder URLs + `DEV_HARNESS_URL = ws://localhost:8787`) and `Config.local.xcconfig` (gitignored, real Fly URLs at integration); `Config.swift` reads them from Info.plist-injected build settings.
- **Agent build workflow:** compile-check with `xcodebuild -scheme Wingman -destination 'generic/platform=iOS' build` (or `-destination 'platform=iOS Simulator,name=iPhone 16'` for runnable checks); run tests with `xcodebuild test -scheme Wingman -destination 'platform=iOS Simulator,...'`. Deploys to the physical phone go through Xcode's Run button or `xcrun devicectl device install app` — expect the human's finger for the first-install trust prompt (Settings → General → VPN & Device Management → trust the developer) and for any DAT pairing dialogs. Guard all DAT calls behind a hardware check so the app **runs simulator-degraded** (StatusView + CortexSocket + FrameSampler-from-a-test-image work in the Simulator; only real streaming/rendering needs glasses).
- **Phone/glasses prerequisites (surface as a checklist for the human — you cannot do these):** iPhone Developer Mode on (one reboot) · phone trusts the Mac · Meta AI app v272+, signed into the same Meta account as the developer enrollment · glasses firmware v125+, paired, Developer Mode toggled in the Meta AI app · tester enrollment done.

### Required `INTEGRATION(X-MACHINE)` comment sites (§0.7) — Mac

| Site | COUNTERPART | AT-INTEGRATION says |
|---|---|---|
| `Protocol.swift` (file header) | `shared/src/protocol.ts` | nothing — header also records provenance: "transcribed from DESIGN.md §4.2, v2 frozen 2026-09-12"; never resynced from cortex source |
| `CortexSocket.swift` — URL + token resolution | `DeviceGateway.ts` | `INTEGRATION-DAY:` swap `DEV_HARNESS_URL` for `CORTEX_WS_URL` from `Config.local.xcconfig` |
| `Config.xcconfig` placeholders | `fly.toml` / deployed Cortex | `INTEGRATION-DAY:` human fills `Config.local.xcconfig` with the real URLs handed over from the Windows side |
| `StatusView.swift` — link-code claim call | `/api/devices/claim` route | run once against live Cortex; token lands in Keychain; expect 404 until Windows deploys (visible, recoverable error) |
| `FrameSampler.swift` / `HudRenderer.swift` — `armed.config` application | `SessionOrchestrator` config emission | verify received config overrides compiled defaults (log both on arm) |
| `AudioKeepalive.swift` | none (Windows-independent) | re-run the 5-min locked-phone stream against live Cortex at M2 |

## 2. Build order & self-contained acceptance checks (none require the Windows side)

1. **Hour-zero hardware spike (gates everything, DESIGN.md §5.1):** the moment glasses are in hand — camera stream + display on ONE `DeviceSession`; sample a frame, render a hello-world card. Report the result to the human immediately; a failure triggers the §6 cut line, not improvisation.
2. DAT sample app running; Mock Device Kit covers the camera/frame path pre-hardware (the display path is hardware-only — do not attempt to simulate it).
3. `CortexSocket` + `FrameSampler` against `DevHarness`. **Check:** harness logs valid `hello`/`session_start`/`frame` JSON at the right cadence and sizes; kill/restart the harness → socket reconnects and re-sends `session_start`.
4. `HudRenderer` against the harness card script. **Check:** every `kind` renders; rotation updates replace in place; coalescing verified (burst 5 renders in 200 ms → ≤ 1 screen replace per 500 ms, last card wins).
5. `AudioKeepalive`. **Check:** phone locked 5 minutes, harness still receiving frames (this is the M2 screen-lock test run early, against the harness).
6. Link flow + Keychain + `StatusView` with placeholder URL (claim call will 404 until integration — handle it as a visible, recoverable error, which is itself the check).

## 3. What you need from the Windows side (via the human, at integration)

The deployed Cortex URLs (into `Config.local.xcconfig`) · a dashboard showing the 6-digit link code · the `/feed` page as your window into what Cortex thinks the glasses are seeing. Until those exist, `DevHarness` is your Cortex.

## 4. Forbidden

Touching any file outside `glassbridge/` · editing `shared/` or any `DESIGN*.md` · deriving `Protocol.swift` from `cortex/` source instead of DESIGN.md §4 · changing wire field names or adding required fields · strict-decoding that rejects unknown fields · putting real URLs or tokens in committed files. When blocked on any of these: stop, ask the human.
