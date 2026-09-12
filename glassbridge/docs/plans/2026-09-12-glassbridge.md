# GlassBridge (Mac side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `glassbridge/` — the Swift iOS app "Wingman" (GlassBridge) of DESIGN.md §5.1: a dumb pipe that streams sampled glasses-camera frames to Cortex over WebSocket and renders `HudCard`s on the Meta Ray-Ban Display, plus its Node DevHarness and tests — exactly as DESIGN_MAC.md assigns, touching nothing outside `glassbridge/`.

**Architecture:** Flat source layout per DESIGN.md Appendix B (`glassbridge/Wingman/*.swift`). Platform-neutral modules (Protocol, Config, FrameSampler, RenderCoalescer, CortexSocket, LinkClient, Keychain) compile on macOS via a `Package.swift` so they are unit-tested with `swift test` without a phone; iOS/DAT-only modules (App, StatusView, BridgeController, DATSessionManager, AudioKeepalive, the DAT half of HudRenderer) are guarded with `#if os(iOS)` / `#if canImport(MWDATCore)` and compile only in the Xcode app target. The Xcode project is generated from a committed `project.yml` (XcodeGen) so the `.xcodeproj` is reproducible; the generated project is committed too.

**Tech Stack:** Swift 5 language mode, SwiftUI, iOS 17.2+, Meta Wearables DAT `facebook/meta-wearables-dat-ios` exactly 0.9.0 (`MWDATCore`, `MWDATCamera`, `MWDATDisplay`, `MWDATMockDevice`), `URLSessionWebSocketTask`, ImageIO, AVFoundation, Security (Keychain), XCTest; Node 22 + `ws` for DevHarness; XcodeGen 2.46.

**Spec:** `DESIGN.md` (normative, frozen v2 — §4 contracts, §5.1 GlassBridge, Appendix B layout, Appendix D constants) and `DESIGN_MAC.md` (scope, §0 merge contract, §1.1 Xcode mechanics, required INTEGRATION sites, §2 acceptance checks). DAT API facts: `glassbridge/docs/dat-0.9.0-api-notes.md` (every signature copied from the 0.9.0 `.swiftinterface` files — use these names verbatim, never guess).

## Global Constraints

- **Path ownership:** create/modify/delete files ONLY under `glassbridge/`. Never touch root files, `shared/`, `cortex/`, `console/`, `corpus/`, or any `DESIGN*.md`. Xcode ignore rules go in `glassbridge/.gitignore`.
- **Wire contract is frozen:** `Protocol.swift` is transcribed from DESIGN.md §4.2 (never from `cortex/` source). Wire field names stay camelCase exactly as in DESIGN.md. Encode strictly (exact shapes, no extra fields); decode leniently (unknown fields ignored; unknown message `type` → `.unknown`, never a thrown error). No new required fields, no renames. If a contract change seems necessary: STOP and surface it to the human.
- **Compiled defaults (DESIGN.md Appendix D):** `frameIntervalMs = 1750`, `frameMaxEdgePx = 768`, `docMaxEdgePx = 2048`, `renderMinGapMs = 500`. `armed.config`, when present, overrides ALL of them (server is authoritative).
- **Frame spec:** sample 1 frame per `frameIntervalMs`; downscale longest edge ≤ `frameMaxEdgePx` (never upscale); JPEG quality ≈ 0.6; target ≤ 120 KB; `mime` is always `"image/jpeg"`. **Photo spec:** longest edge ≤ `docMaxEdgePx`, JPEG quality ≈ 0.8; failure → `photo_error` with the same `reqId`.
- **Renderer contract:** DAT display is full-screen replace only; coalesce renders so screen replaces are ≥ `renderMinGapMs` apart, always drawing the LATEST card; title + subtitle + max 5 lines ≈ 40 chars + footer; never wrap-scroll (clip defensively). Same `cardId` + higher `seq` = replace in place. Devices are stateless renderers — Cortex owns rotation timing; `minDisplaySec` is informational only on this device (Ruling: Cortex already enforces the hold, DESIGN.md §3.3).
- **Keepalive (DESIGN.md §5.1):** `audio` in `UIBackgroundModes`; `AVAudioSession` category `.playback` + `.mixWithOthers`; looped silent file via `AVAudioPlayer` (`numberOfLoops = -1`); restart on `AVAudioSession.interruptionNotification`; stop at session Stop.
- **Xcode project (DESIGN_MAC.md §1.1):** product `Wingman`, bundle ID `com.hackrice.wingman`, minimum iOS 17.2, SwiftUI lifecycle, DAT SPM package pinned **exactly 0.9.0** (Package.resolved committed), Background Modes → Audio, automatic signing with the Personal Team (`DEVELOPMENT_TEAM` comes from `Config.local.xcconfig`, never committed).
- **Info.plist:** `NSBluetoothAlwaysUsageDescription` = "Wingman connects to your Meta glasses."; `NSLocalNetworkUsageDescription` = "Wingman streams from your Meta glasses."; `NSBonjourServices` = `_bonjour._tcp` (named by the DAT sample Info.plist); `NSAllowsLocalNetworking = true` (only so `ws://` reaches DevHarness); **NO** `NSMicrophoneUsageDescription`, **NO** `NSCameraUsageDescription`. DAT registration keys per `docs/dat-0.9.0-api-notes.md` §2 (`MWDAT` dict, URL scheme `wingman`).
- **Secrets:** no real URLs, tokens, or team IDs in committed files. `Config.xcconfig` ships `REPLACE-ME` placeholders; `Config.local.xcconfig` is gitignored.
- **Comments:** every cross-machine seam carries the exact `// INTEGRATION(X-MACHINE):` 4-line block of DESIGN_MAC.md §0.7 (`COUNTERPART` / `CONTRACT` / `AT-INTEGRATION`), deferred items carry `INTEGRATION-DAY: <exact action>`; every module seam carries the DESIGN.md §7 `// INTEGRATION:` block (`IN` / `OUT` / `WIRE`). Required X-MACHINE sites: `Protocol.swift` header, `CortexSocket.swift` URL/token resolution, `Config.xcconfig` placeholders, `StatusView.swift` claim call, `FrameSampler.swift` + `HudRenderer.swift` `armed.config` application, `AudioKeepalive.swift`.
- **Simulator-degraded:** every DAT call is behind `#if canImport(MWDATCore)` plus a runtime `DATSessionManager.isHardwareAvailable` check; StatusView, CortexSocket, FrameSampler-from-a-test-image work in the Simulator.
- **Language/tests:** Swift language mode 5 (`SWIFT_VERSION = 5.0`, `swiftLanguageVersions: [.v5]`). Tests are XCTest in `glassbridge/WingmanTests/`, importing via the shim `#if canImport(WingmanCore) @testable import WingmanCore #else @testable import Wingman #endif` so the same files run under `swift test` (macOS) and `xcodebuild test` (Xcode).
- **Build commands:** from `glassbridge/`: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path <your-scratch-dir>` (use a per-task scratch path so parallel tasks never share `.build`). If the Xcode license is not yet accepted on this Mac, `swift build --scratch-path …` (Command Line Tools) is the compile check and the report must say "tests written, not executed: Xcode license pending".
- **Git:** commit only files under `glassbridge/`. Never `git add -A`. End every commit message with the line `Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz`.
- **No subagents from implementers.** Implementers write Swift/Node source only; they never edit `project.yml` or the `.xcodeproj` after Task 1 (the orchestrator regenerates the project in Task 10).

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `glassbridge/.gitignore` | 1 | Xcode/SwiftPM/local-config ignores |
| `glassbridge/README.md` | 1 (stub), 10 (final) | human checklist, build/run, harness, integration handoff |
| `glassbridge/Package.swift` | 1 | macOS-testable core package (`WingmanCore` ← `Wingman/`, `WingmanCoreTests` ← `WingmanTests/`) |
| `glassbridge/project.yml` → `Wingman.xcodeproj` | 1 | XcodeGen spec: app + test targets, DAT 0.9.0, xcconfigs |
| `glassbridge/Config.xcconfig`, `Config.local.xcconfig.example` | 1 | URL placeholders, team, Meta IDs |
| `glassbridge/Wingman/Info.plist`, `Wingman.entitlements` | 1 | permissions, background modes, DAT registration keys |
| `glassbridge/Wingman/App.swift` | 1 | `@main` SwiftUI app, `Wearables.configure()`, `onOpenURL` |
| `glassbridge/Wingman/Config.swift` | 1 | reads xcconfig-injected Info.plist values |
| `glassbridge/docs/dat-0.9.0-api-notes.md` | 1 | DAT API reference (already present) |
| `glassbridge/Wingman/Protocol.swift` | 2 | hand-mirror of DESIGN.md §4.2 + §4.1 claim DTOs |
| `glassbridge/WingmanTests/ProtocolTests.swift` | 2 | round-trips of every §4.2 example, leniency |
| `glassbridge/Wingman/FrameSampler.swift` | 3 | cadence, downscale, JPEG, `frame`/`photo` emission |
| `glassbridge/WingmanTests/FrameSamplerTests.swift` | 3 | downscale math, size, cadence |
| `glassbridge/Wingman/HudRenderer.swift` | 4 | `RenderCoalescer` (neutral) + `HudRenderer` → DAT FlexBox (iOS) |
| `glassbridge/WingmanTests/HudRendererTests.swift` | 4 | coalescing timing, clipping |
| `glassbridge/Wingman/CortexSocket.swift`, `LinkClient.swift`, `Keychain.swift` | 5 | WS + reconnect + heartbeat; claim REST; token storage |
| `glassbridge/WingmanTests/CortexSocketTests.swift`, `ConfigTests.swift` | 5 | handshake order, reconnect, URL derivation |
| `glassbridge/DevHarness/package.json`, `harness.mjs`, `fake-device.mjs` | 6 | fake Cortex (HTTP claim + WS), scripted cards, validation; fake device client |
| `glassbridge/Wingman/AudioKeepalive.swift` | 7 | silent-audio lock survival |
| `glassbridge/WingmanTests/SilentWavTests.swift` | 7 | WAV header sanity |
| `glassbridge/Wingman/DATSessionManager.swift` | 8 | ONE DeviceSession: camera stream + display |
| `glassbridge/Wingman/BridgeController.swift`, `StatusView.swift` | 9 | wiring + the one status screen + spike |
| `Wingman.xcodeproj/.../Package.resolved`, README final | 10 | Xcode build/test gate, INTEGRATION grep |

Dependency order: 1 → 2 → {3, 4, 5, 6, 7, 8 in parallel, disjoint files} → 9 → 10.

---

### Task 1: Project skeleton (SwiftPM core package + XcodeGen project + config split)

**Files:**
- Create: `glassbridge/.gitignore`
- Create: `glassbridge/README.md`
- Create: `glassbridge/Package.swift`
- Create: `glassbridge/project.yml`
- Create: `glassbridge/Config.xcconfig`
- Create: `glassbridge/Config.local.xcconfig.example`
- Create: `glassbridge/Wingman/Info.plist`
- Create: `glassbridge/Wingman/Wingman.entitlements`
- Create: `glassbridge/Wingman/App.swift`
- Create: `glassbridge/Wingman/Config.swift`
- Create: `glassbridge/WingmanTests/TestImports.swift`
- Generate: `glassbridge/Wingman.xcodeproj` (via `xcodegen generate`)

**Interfaces:**
- Consumes: nothing.
- Produces: `enum Config { static var cortexURL: URL; static var cortexWSURL: URL; static var devHarnessWSURL: URL; static var devHarnessHTTPURL: URL; static var isCortexConfigured: Bool }`; the `WingmanCore` package target whose `exclude:` list names the iOS-only files later tasks will add; the test-import shim pattern.

- [ ] **Step 1: Write `glassbridge/.gitignore`**

```gitignore
# glassbridge/.gitignore — Mac-owned (DESIGN_MAC.md §0). Root .gitignore stays Node-only.
xcuserdata/
*.xcuserstate
DerivedData/
.build/
.swiftpm/
*.xcodeproj/project.xcworkspace/xcuserdata/
*.xcodeproj/xcuserdata/
# real URLs / team ID live here, never committed (DESIGN_MAC.md §1.1)
Config.local.xcconfig
DevHarness/node_modules/
DevHarness/frames/
```

- [ ] **Step 2: Write `glassbridge/Package.swift`**

```swift
// swift-tools-version:5.9
// glassbridge/Package.swift — macOS-testable slice of the app. The Xcode app target (project.yml)
// compiles ALL of Wingman/; this package compiles only the platform-neutral files so
// `swift test` runs on the Mac with no phone, no glasses, no DAT. iOS-only files are excluded
// below AND guarded with #if os(iOS) / #if canImport(MWDATCore) in source.
import PackageDescription

let package = Package(
  name: "WingmanCore",
  platforms: [.macOS(.v14), .iOS(.v17)],
  targets: [
    .target(
      name: "WingmanCore",
      path: "Wingman",
      exclude: [
        "Info.plist",
        "Wingman.entitlements",
        "App.swift",
        "StatusView.swift",
        "BridgeController.swift",
        "DATSessionManager.swift",
      ]
    ),
    .testTarget(
      name: "WingmanCoreTests",
      dependencies: ["WingmanCore"],
      path: "WingmanTests"
    ),
  ],
  swiftLanguageVersions: [.v5]
)
```

- [ ] **Step 3: Write `glassbridge/Config.xcconfig` and the local example**

`glassbridge/Config.xcconfig`:
```
// Config.xcconfig — COMMITTED placeholders (DESIGN_MAC.md §1.1). Real values go in
// Config.local.xcconfig (gitignored), included at the bottom; local values win.
// xcconfig treats "//" as a comment, so URLs are written as scheme:/$()/host — $() expands to nothing.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex fly.toml / the deployed Cortex on Fly.io (Windows side hands over the URLs)
// CONTRACT: DESIGN.md §4.1 REST base URL (https://…) and §4.2 device WebSocket (wss://…/ws/device?token=)
// AT-INTEGRATION: INTEGRATION-DAY: human copies Config.local.xcconfig.example → Config.local.xcconfig, fills CORTEX_URL and CORTEX_WS_URL with the real Fly URLs (keep the /ws/device path), sets DEVELOPMENT_TEAM, rebuilds onto the phone.
CORTEX_URL = https:/$()/REPLACE-ME.fly.dev
CORTEX_WS_URL = wss:/$()/REPLACE-ME.fly.dev/ws/device
// DevHarness (glassbridge/DevHarness/harness.mjs). On a physical phone replace localhost with the Mac's LAN IP.
DEV_HARNESS_URL = ws:/$()/localhost:8787/ws/device
// Personal Team ID from Xcode → Settings → Accounts (10 chars). Empty here; set locally.
DEVELOPMENT_TEAM =
// DAT registration (docs/dat-0.9.0-api-notes.md §2). "0" = Developer Mode, no Developer Center provisioning needed.
META_APP_ID = 0
META_CLIENT_TOKEN =
#include? "Config.local.xcconfig"
```

`glassbridge/Config.local.xcconfig.example`:
```
// Copy to Config.local.xcconfig (gitignored) and fill in. Values here override Config.xcconfig.
// URLs: write "//" as "/$()/" — xcconfig treats "//" as a comment start.
CORTEX_URL = https:/$()/wingman-cortex.fly.dev
CORTEX_WS_URL = wss:/$()/wingman-cortex.fly.dev/ws/device
DEV_HARNESS_URL = ws:/$()/192.168.1.23:8787/ws/device
DEVELOPMENT_TEAM = ABCDE12345
META_APP_ID = 0
META_CLIENT_TOKEN =
```

- [ ] **Step 4: Write `glassbridge/Wingman/Info.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundleDisplayName</key><string>Wingman</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>UILaunchScreen</key><dict/>
  <key>UIApplicationSceneManifest</key>
  <dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>
  <key>UISupportedInterfaceOrientations</key>
  <array><string>UIInterfaceOrientationPortrait</string></array>

  <!-- Wingman config, injected from Config.xcconfig / Config.local.xcconfig (DESIGN_MAC.md §1.1); read by Config.swift -->
  <key>CORTEX_URL</key><string>$(CORTEX_URL)</string>
  <key>CORTEX_WS_URL</key><string>$(CORTEX_WS_URL)</string>
  <key>DEV_HARNESS_URL</key><string>$(DEV_HARNESS_URL)</string>

  <!-- DESIGN_MAC.md §1.1 permissions. Deliberately NO NSMicrophoneUsageDescription (D1: no mic) and NO NSCameraUsageDescription (phone camera never used). -->
  <key>NSBluetoothAlwaysUsageDescription</key><string>Wingman connects to your Meta glasses.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Wingman streams from your Meta glasses.</string>
  <key>NSBonjourServices</key><array><string>_bonjour._tcp</string></array>

  <!-- audio = silent keepalive (DESIGN.md §5.1). bluetooth-*/processing = DAT link in background (DAT sample Info.plist). -->
  <key>UIBackgroundModes</key>
  <array>
    <string>audio</string>
    <string>bluetooth-central</string>
    <string>bluetooth-peripheral</string>
    <string>processing</string>
  </array>

  <!-- DAT 0.9.0 registration round-trip with the Meta AI app (docs/dat-0.9.0-api-notes.md §2) -->
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>CFBundleURLName</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
      <key>CFBundleURLSchemes</key><array><string>wingman</string></array>
    </dict>
  </array>
  <key>LSApplicationQueriesSchemes</key><array><string>fb-viewapp</string></array>
  <key>MWDAT</key>
  <dict>
    <key>AppLinkURLScheme</key><string>wingman://</string>
    <key>MetaAppID</key><string>$(META_APP_ID)</string>
    <key>ClientToken</key><string>$(META_CLIENT_TOKEN)</string>
    <key>TeamID</key><string>$(DEVELOPMENT_TEAM)</string>
  </dict>

  <!-- Only so ws://<LAN IP>:8787 (DevHarness) is reachable; production is wss:// and unaffected. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
```

`glassbridge/Wingman/Wingman.entitlements`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array><string>$(AppIdentifierPrefix)com.hackrice.wingman</string></array>
</dict>
</plist>
```

- [ ] **Step 5: Write `glassbridge/project.yml`**

```yaml
# glassbridge/project.yml — XcodeGen spec. `xcodegen generate` (from glassbridge/) rewrites
# Wingman.xcodeproj. Edit THIS file, regenerate, commit both. Mechanics per DESIGN_MAC.md §1.1.
name: Wingman
options:
  bundleIdPrefix: com.hackrice
  deploymentTarget:
    iOS: "17.2"
  xcodeVersion: "15.0"
  createIntermediateGroups: true
configs:
  Debug: debug
  Release: release
configFiles:
  Debug: Config.xcconfig
  Release: Config.xcconfig
packages:
  MetaWearablesDAT:
    url: https://github.com/facebook/meta-wearables-dat-ios
    exactVersion: 0.9.0
settings:
  base:
    SWIFT_VERSION: "5.0"
    CODE_SIGN_STYLE: Automatic
targets:
  Wingman:
    type: application
    platform: iOS
    sources:
      - path: Wingman
        excludes: ["Info.plist", "Wingman.entitlements"]
    dependencies:
      - package: MetaWearablesDAT
        product: MWDATCore
      - package: MetaWearablesDAT
        product: MWDATCamera
      - package: MetaWearablesDAT
        product: MWDATDisplay
      - package: MetaWearablesDAT
        product: MWDATMockDevice
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.hackrice.wingman
        PRODUCT_NAME: Wingman
        GENERATE_INFOPLIST_FILE: NO
        INFOPLIST_FILE: Wingman/Info.plist
        CODE_SIGN_ENTITLEMENTS: Wingman/Wingman.entitlements
        TARGETED_DEVICE_FAMILY: "1"
        SWIFT_STRICT_CONCURRENCY: minimal
  WingmanTests:
    type: bundle.unit-test
    platform: iOS
    sources: [WingmanTests]
    dependencies:
      - target: Wingman
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.hackrice.wingman.tests
        GENERATE_INFOPLIST_FILE: YES
schemes:
  Wingman:
    build:
      targets:
        Wingman: all
        WingmanTests: [test]
    run:
      config: Debug
    test:
      config: Debug
      targets: [WingmanTests]
```

- [ ] **Step 6: Write `glassbridge/Wingman/Config.swift`**

```swift
// Config.swift — build-time configuration injected via Config.xcconfig → Info.plist (DESIGN_MAC.md §1.1).
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex fly.toml / deployed Cortex (Windows side provides the URLs)
// CONTRACT: DESIGN.md §4.1 base URL (https://…) and §4.2 device WebSocket (wss://…/ws/device?token=)
// AT-INTEGRATION: INTEGRATION-DAY: nothing here — values arrive via Config.local.xcconfig (see Config.xcconfig).
//
// INTEGRATION: Config
// IN:  Info.plist keys CORTEX_URL, CORTEX_WS_URL, DEV_HARNESS_URL (strings, may be placeholders)
// OUT: URLs for LinkClient (REST base) and CortexSocket (WS); isCortexConfigured for the DevHarness default
// WIRE: BridgeController picks Config.cortexWSURL vs Config.devHarnessWSURL by its useDevHarness toggle

import Foundation

enum Config {
  static let placeholderHost = "REPLACE-ME"

  private static func string(_ key: String, default def: String) -> String {
    let v = Bundle.main.object(forInfoDictionaryKey: key) as? String
    return (v?.isEmpty == false) ? v! : def
  }

  /// REST base, e.g. https://wingman-cortex.fly.dev
  static var cortexURL: URL { URL(string: string("CORTEX_URL", default: "https://\(placeholderHost).fly.dev"))! }
  /// Device WebSocket, e.g. wss://wingman-cortex.fly.dev/ws/device (token appended by CortexSocket)
  static var cortexWSURL: URL { URL(string: string("CORTEX_WS_URL", default: "wss://\(placeholderHost).fly.dev/ws/device"))! }
  /// DevHarness WebSocket (glassbridge/DevHarness/harness.mjs)
  static var devHarnessWSURL: URL { URL(string: string("DEV_HARNESS_URL", default: "ws://localhost:8787/ws/device"))! }
  /// HTTP origin of the harness (it serves /api/devices/claim on the same port), derived from the WS URL.
  static var devHarnessHTTPURL: URL { httpOrigin(of: devHarnessWSURL) }
  /// False while Config.xcconfig still holds the REPLACE-ME placeholder → default to DevHarness.
  static var isCortexConfigured: Bool { !cortexWSURL.absoluteString.contains(placeholderHost) }

  static func httpOrigin(of wsURL: URL) -> URL {
    var c = URLComponents(url: wsURL, resolvingAgainstBaseURL: false)!
    c.scheme = (c.scheme == "wss") ? "https" : "http"
    c.path = ""
    c.query = nil
    return c.url!
  }
}
```

- [ ] **Step 7: Write `glassbridge/Wingman/App.swift`**

```swift
// App.swift — SwiftUI lifecycle. Configures DAT at launch, routes the Meta AI registration
// callback URL, and shows the single StatusView (DESIGN.md §5.1 responsibility 4).
import SwiftUI
#if canImport(MWDATCore)
import MWDATCore
#endif

@main
struct WingmanApp: App {
  @StateObject private var bridge = BridgeController()

  init() {
    #if canImport(MWDATCore)
    do { try Wearables.configure() } catch { NSLog("Wearables.configure failed: \(error)") }
    #endif
    UIDevice.current.isBatteryMonitoringEnabled = true
  }

  var body: some Scene {
    WindowGroup {
      StatusView()
        .environmentObject(bridge)
        .onOpenURL { url in Task { await bridge.handleOpenURL(url) } }
    }
  }
}
```

- [ ] **Step 8: Write the test-import shim `glassbridge/WingmanTests/TestImports.swift`**

```swift
// TestImports.swift — every test file starts with this same #if block (copy it; Swift has no
// re-export). Under `swift test` the module is WingmanCore; under Xcode it is the app, Wingman.
import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class SmokeTests: XCTestCase {
  func testConfigPlaceholderIsDefault() {
    // No Info.plist under swift test → defaults → not configured → harness is the default.
    XCTAssertFalse(Config.isCortexConfigured)
  }
}
```

- [ ] **Step 9: Write the README stub `glassbridge/README.md`**

```markdown
# GlassBridge (`glassbridge/`) — Mac-owned

Swift iOS app **Wingman**: the dumb pipe of DESIGN.md §5.1 (glasses camera → Cortex, HudCard → lens).
Build plan: `docs/plans/2026-09-12-glassbridge.md`. DAT API notes: `docs/dat-0.9.0-api-notes.md`.

## Build
- Xcode: `xcodegen generate` (only after editing `project.yml`), open `Wingman.xcodeproj`, scheme `Wingman`.
- CLI compile check: `xcodebuild -scheme Wingman -destination 'generic/platform=iOS' build`
- Unit tests, no phone: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test`
- Config: copy `Config.local.xcconfig.example` → `Config.local.xcconfig` (gitignored), fill URLs + team.

(Expanded in Task 10: human checklist, DevHarness, integration handoff.)
```

- [ ] **Step 10: Generate the Xcode project and compile-check the core package**

Run (from `glassbridge/`):
```bash
xcodegen generate
swift build --scratch-path /tmp/wingman-build-task1
```
Expected: `xcodegen` prints "Created project at …/Wingman.xcodeproj"; `swift build` ends with `Build complete!` (only Config.swift compiles into WingmanCore; the excluded files are absent and SwiftPM only warns about missing exclude paths). If `swift build` fails on `xcodebuild`-license grounds, run it without `DEVELOPER_DIR` set (Command Line Tools) — it must still pass.

- [ ] **Step 11: Commit**

```bash
git add glassbridge/.gitignore glassbridge/README.md glassbridge/Package.swift glassbridge/project.yml \
  glassbridge/Config.xcconfig glassbridge/Config.local.xcconfig.example glassbridge/Wingman glassbridge/WingmanTests \
  glassbridge/Wingman.xcodeproj glassbridge/docs
git commit -m "glassbridge: project skeleton (SwiftPM core, XcodeGen project, config split, Info.plist)

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 2: Protocol.swift — hand-mirror of DESIGN.md §4.2

**Files:**
- Create: `glassbridge/Wingman/Protocol.swift`
- Create: `glassbridge/WingmanTests/ProtocolTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task, names exact):
  - `enum DeviceType: String, Codable { glassesBridge = "glasses_bridge", phoneWeb = "phone_web" }`
  - `enum CardKind: String, Codable { ack, company, pitch, scan, hint, error }`
  - `enum ErrorCode: String, Codable` (7 cases), `enum SessionEndReason: String, Codable { userStop = "user_stop", error }`
  - `struct HudCard: Codable, Equatable` with nested `Page { index, count }`, `CompanyRef { companyId, confidence }`
  - `struct DeviceCaps: Codable, Equatable { video, photoHiRes }`
  - `struct ArmedConfig: Codable, Equatable { frameIntervalMs, frameMaxEdgePx, docMaxEdgePx, renderMinGapMs: Int; static let defaults }`
  - `enum DeviceToCortex: Encodable, Equatable { hello(deviceType:caps:), sessionStart, sessionStop, frame(seq:ts:dataBase64:), photo(reqId:dataBase64:), photoError(reqId:reason:), status(battery:note:) }`
  - `enum CortexToDevice: Decodable, Equatable { armed(sessionId:config:), capturePhoto(reqId:quality:), render(card:), sessionEnd(reason:), error(code:message:recoverable:), unknown(type:) }`
  - `struct ClaimRequest: Encodable { code, deviceType = .glassesBridge, name }`, `struct ClaimResponse: Decodable, Equatable { deviceId, deviceToken }`
  - `enum Wire { static let encoder: JSONEncoder; static let decoder: JSONDecoder; static func encode(_: DeviceToCortex) -> String; static func decode(_: String) throws -> CortexToDevice }`

- [ ] **Step 1: Write the failing tests `glassbridge/WingmanTests/ProtocolTests.swift`**

```swift
import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

/// Every JSON literal below is copied verbatim from DESIGN.md §4.2 / §4.1.
final class ProtocolTests: XCTestCase {

  private func json(_ s: String) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any])
  }

  // MARK: Cortex → Device (decode, lenient)

  func testDecodesArmedWithConfig() throws {
    let s = #"{ "type": "armed", "sessionId": "s_42", "config": { "frameIntervalMs": 1750, "frameMaxEdgePx": 768, "docMaxEdgePx": 2048, "renderMinGapMs": 500 } }"#
    XCTAssertEqual(try Wire.decode(s), .armed(sessionId: "s_42", config: ArmedConfig(frameIntervalMs: 1750, frameMaxEdgePx: 768, docMaxEdgePx: 2048, renderMinGapMs: 500)))
  }

  func testDecodesArmedWithoutConfigFallsBackToNil() throws {
    XCTAssertEqual(try Wire.decode(#"{ "type": "armed", "sessionId": "s_42" }"#), .armed(sessionId: "s_42", config: nil))
    XCTAssertEqual(ArmedConfig.defaults, ArmedConfig(frameIntervalMs: 1750, frameMaxEdgePx: 768, docMaxEdgePx: 2048, renderMinGapMs: 500))
  }

  func testDecodesCapturePhoto() throws {
    XCTAssertEqual(try Wire.decode(#"{ "type": "capture_photo", "reqId": "r_18", "quality": "document" }"#), .capturePhoto(reqId: "r_18", quality: "document"))
  }

  func testDecodesRenderWithFullHudCard() throws {
    let s = #"""
    { "type": "render", "card": {
      "cardId": "c_007", "seq": 3, "kind": "company", "title": "Stripe",
      "subtitle": "Payments infrastructure for the internet",
      "lines": [ "Hiring: SWE Intern, New Grad Backend", "Stack: Ruby, Go, ML infra at scale", "Recently: launched usage-based billing APIs" ],
      "footer": "Wingman · 1/2", "page": { "index": 1, "count": 2 }, "streaming": false,
      "company": { "companyId": "stripe", "confidence": 0.93 }, "minDisplaySec": 15 } }
    """#
    guard case let .render(card) = try Wire.decode(s) else { return XCTFail("not render") }
    XCTAssertEqual(card.cardId, "c_007"); XCTAssertEqual(card.seq, 3); XCTAssertEqual(card.kind, .company)
    XCTAssertEqual(card.title, "Stripe"); XCTAssertEqual(card.subtitle, "Payments infrastructure for the internet")
    XCTAssertEqual(card.lines?.count, 3); XCTAssertEqual(card.footer, "Wingman · 1/2")
    XCTAssertEqual(card.page, HudCard.Page(index: 1, count: 2)); XCTAssertEqual(card.streaming, false)
    XCTAssertEqual(card.company, HudCard.CompanyRef(companyId: "stripe", confidence: 0.93)); XCTAssertEqual(card.minDisplaySec, 15)
  }

  func testDecodesMinimalHudCard() throws {
    guard case let .render(card) = try Wire.decode(#"{ "type": "render", "card": { "cardId": "c_1", "seq": 1, "kind": "ack", "title": "Identifying…" } }"#) else { return XCTFail() }
    XCTAssertNil(card.subtitle); XCTAssertNil(card.lines); XCTAssertNil(card.page); XCTAssertEqual(card.kind, .ack)
  }

  func testDecodesSessionEndAndError() throws {
    XCTAssertEqual(try Wire.decode(#"{ "type": "session_end", "reason": "user_stop" }"#), .sessionEnd(reason: .userStop))
    XCTAssertEqual(try Wire.decode(#"{ "type": "session_end", "reason": "error" }"#), .sessionEnd(reason: .error))
    XCTAssertEqual(try Wire.decode(#"{ "type": "error", "code": "identify_timeout", "message": "…", "recoverable": true }"#), .error(code: .identifyTimeout, message: "…", recoverable: true))
    for raw in ["gate_down", "identify_timeout", "no_match", "search_down", "llm_down", "rate_limited", "photo_failed"] {
      XCTAssertNotNil(ErrorCode(rawValue: raw), raw)
    }
  }

  func testUnknownFieldsAreIgnored() throws {
    let s = #"{ "type": "render", "future": 1, "card": { "cardId": "c_1", "seq": 1, "kind": "hint", "title": "x", "extra": { "a": 1 } } }"#
    guard case .render = try Wire.decode(s) else { return XCTFail() }
  }

  func testUnknownMessageTypeIsTolerated() throws {
    XCTAssertEqual(try Wire.decode(#"{ "type": "telemetry", "x": 1 }"#), .unknown(type: "telemetry"))
  }

  // MARK: Device → Cortex (encode, strict)

  func testEncodesHello() throws {
    let d = try json(Wire.encode(.hello(deviceType: .glassesBridge, caps: DeviceCaps(video: true, photoHiRes: true))))
    XCTAssertEqual(d as NSDictionary, ["type": "hello", "deviceType": "glasses_bridge", "caps": ["video": true, "photoHiRes": true]] as NSDictionary)
  }

  func testEncodesSessionStartStop() throws {
    XCTAssertEqual(try json(Wire.encode(.sessionStart)) as NSDictionary, ["type": "session_start"] as NSDictionary)
    XCTAssertEqual(try json(Wire.encode(.sessionStop)) as NSDictionary, ["type": "session_stop"] as NSDictionary)
  }

  func testEncodesFrame() throws {
    let d = try json(Wire.encode(.frame(seq: 412, ts: 1757700000123, dataBase64: "AAAA")))
    XCTAssertEqual(d as NSDictionary, ["type": "frame", "seq": 412, "ts": 1757700000123, "mime": "image/jpeg", "dataBase64": "AAAA"] as NSDictionary)
  }

  func testEncodesPhotoAndPhotoError() throws {
    XCTAssertEqual(try json(Wire.encode(.photo(reqId: "r_18", dataBase64: "AAAA"))) as NSDictionary,
                   ["type": "photo", "reqId": "r_18", "mime": "image/jpeg", "dataBase64": "AAAA"] as NSDictionary)
    XCTAssertEqual(try json(Wire.encode(.photoError(reqId: "r_18", reason: "capture_failed"))) as NSDictionary,
                   ["type": "photo_error", "reqId": "r_18", "reason": "capture_failed"] as NSDictionary)
  }

  func testEncodesStatusOmittingNilFields() throws {
    XCTAssertEqual(try json(Wire.encode(.status(battery: 0.61, note: "reconnected"))) as NSDictionary,
                   ["type": "status", "battery": 0.61, "note": "reconnected"] as NSDictionary)
    XCTAssertEqual(try json(Wire.encode(.status(battery: nil, note: nil))) as NSDictionary, ["type": "status"] as NSDictionary)
  }

  // MARK: §4.1 claim DTOs

  func testClaimRequestAndResponseShapes() throws {
    let req = try json(String(decoding: try Wire.encoder.encode(ClaimRequest(code: "483291", name: "James's phone")), as: UTF8.self))
    XCTAssertEqual(req as NSDictionary, ["code": "483291", "deviceType": "glasses_bridge", "name": "James's phone"] as NSDictionary)
    let resp = try Wire.decoder.decode(ClaimResponse.self, from: Data(#"{ "deviceId": "d_1", "deviceToken": "tok", "extra": 1 }"#.utf8))
    XCTAssertEqual(resp, ClaimResponse(deviceId: "d_1", deviceToken: "tok"))
  }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `glassbridge/`): `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task2 --filter ProtocolTests`
Expected: compile error "cannot find 'Wire' in scope" (or, without the Xcode license, `swift build` fails the same way).

- [ ] **Step 3: Write `glassbridge/Wingman/Protocol.swift`**

```swift
// Protocol.swift — GlassBridge wire protocol, hand-mirror of DESIGN.md §4.2 (+ §4.1 claim DTOs).
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: shared/src/protocol.ts (Windows side; cortex DeviceGateway encodes/decodes these exact shapes)
// CONTRACT: DESIGN.md §4.2 — device WebSocket messages, HudCard, ErrorCode, armed.config; §4.1 — POST /api/devices/claim
// AT-INTEGRATION: nothing — transcribed from DESIGN.md §4.2, v2 frozen 2026-09-12; never resynced from cortex/ source.
//   Any post-freeze contract change needs human sign-off plus matching manual edits here AND in shared/src/protocol.ts.
//
// Rules (DESIGN_MAC.md §0.4): encode strictly (exactly these shapes, camelCase wire names — Swift property names
// already equal the wire names, so no CodingKeys remapping is needed except enum raw values); decode leniently
// (synthesized Decodable ignores unknown fields; an unknown message `type` becomes `.unknown` instead of an error).
//
// INTEGRATION: Protocol
// IN:  JSON text frames from CortexSocket
// OUT: DeviceToCortex (encode) / CortexToDevice (decode) values used by FrameSampler, HudRenderer, BridgeController
// WIRE: Wire.encode / Wire.decode are the only entry points; nothing else touches JSONEncoder/Decoder.

import Foundation

// MARK: - Shared enums (DESIGN.md §4.2, closed and frozen)

enum DeviceType: String, Codable {
  case glassesBridge = "glasses_bridge"
  case phoneWeb = "phone_web"
}

enum CardKind: String, Codable { case ack, company, pitch, scan, hint, error }

enum ErrorCode: String, Codable {
  case gateDown = "gate_down"
  case identifyTimeout = "identify_timeout"
  case noMatch = "no_match"
  case searchDown = "search_down"
  case llmDown = "llm_down"
  case rateLimited = "rate_limited"
  case photoFailed = "photo_failed"
}

enum SessionEndReason: String, Codable {
  case userStop = "user_stop"
  case error
}

// MARK: - HudCard (DESIGN.md §4.2 — renderer contract: title + subtitle + max 5 lines ≈ 40 chars + footer)

struct HudCard: Codable, Equatable {
  struct Page: Codable, Equatable { var index: Int; var count: Int }
  struct CompanyRef: Codable, Equatable { var companyId: String; var confidence: Double }

  var cardId: String
  var seq: Int
  var kind: CardKind
  var title: String
  var subtitle: String?
  var lines: [String]?
  var footer: String?
  var page: Page?
  var streaming: Bool?
  var company: CompanyRef?
  /// Informational on this device — Cortex owns rotation/hold timing (DESIGN.md §3.3, §4.2).
  var minDisplaySec: Double?
}

struct DeviceCaps: Codable, Equatable {
  var video: Bool
  var photoHiRes: Bool
}

/// Server-authoritative runtime tuning (DESIGN.md §4.2 + Appendix D). Present on `armed` → apply; absent → defaults.
struct ArmedConfig: Codable, Equatable {
  var frameIntervalMs: Int
  var frameMaxEdgePx: Int
  var docMaxEdgePx: Int
  var renderMinGapMs: Int

  /// DESIGN.md Appendix D compiled fallbacks. Overridden by armed.config whenever present.
  static let defaults = ArmedConfig(frameIntervalMs: 1750, frameMaxEdgePx: 768, docMaxEdgePx: 2048, renderMinGapMs: 500)
}

// MARK: - Device → Cortex (encoded strictly)

enum DeviceToCortex: Equatable {
  case hello(deviceType: DeviceType, caps: DeviceCaps)
  case sessionStart
  case sessionStop
  /// seq increments per emitted frame; ts = epoch millis at capture; mime is always image/jpeg.
  case frame(seq: Int, ts: Int64, dataBase64: String)
  case photo(reqId: String, dataBase64: String)
  case photoError(reqId: String, reason: String)
  case status(battery: Double?, note: String?)
}

extension DeviceToCortex: Encodable {
  private enum Key: String, CodingKey { case type, deviceType, caps, seq, ts, mime, dataBase64, reqId, reason, battery, note }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    switch self {
    case let .hello(deviceType, caps):
      try c.encode("hello", forKey: .type)
      try c.encode(deviceType, forKey: .deviceType)
      try c.encode(caps, forKey: .caps)
    case .sessionStart:
      try c.encode("session_start", forKey: .type)
    case .sessionStop:
      try c.encode("session_stop", forKey: .type)
    case let .frame(seq, ts, dataBase64):
      try c.encode("frame", forKey: .type)
      try c.encode(seq, forKey: .seq)
      try c.encode(ts, forKey: .ts)
      try c.encode("image/jpeg", forKey: .mime)
      try c.encode(dataBase64, forKey: .dataBase64)
    case let .photo(reqId, dataBase64):
      try c.encode("photo", forKey: .type)
      try c.encode(reqId, forKey: .reqId)
      try c.encode("image/jpeg", forKey: .mime)
      try c.encode(dataBase64, forKey: .dataBase64)
    case let .photoError(reqId, reason):
      try c.encode("photo_error", forKey: .type)
      try c.encode(reqId, forKey: .reqId)
      try c.encode(reason, forKey: .reason)
    case let .status(battery, note):
      try c.encode("status", forKey: .type)
      try c.encodeIfPresent(battery, forKey: .battery)
      try c.encodeIfPresent(note, forKey: .note)
    }
  }
}

// MARK: - Cortex → Device (decoded leniently)

enum CortexToDevice: Equatable {
  case armed(sessionId: String, config: ArmedConfig?)
  case capturePhoto(reqId: String, quality: String)
  case render(card: HudCard)
  case sessionEnd(reason: SessionEndReason)
  case error(code: ErrorCode, message: String, recoverable: Bool)
  /// A `type` this build does not know — logged and ignored, never fatal.
  case unknown(type: String)
}

extension CortexToDevice: Decodable {
  private enum Key: String, CodingKey { case type, sessionId, config, reqId, quality, card, reason, code, message, recoverable }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "armed":
      self = .armed(sessionId: try c.decode(String.self, forKey: .sessionId),
                    config: try c.decodeIfPresent(ArmedConfig.self, forKey: .config))
    case "capture_photo":
      self = .capturePhoto(reqId: try c.decode(String.self, forKey: .reqId),
                           quality: try c.decodeIfPresent(String.self, forKey: .quality) ?? "document")
    case "render":
      self = .render(card: try c.decode(HudCard.self, forKey: .card))
    case "session_end":
      self = .sessionEnd(reason: try c.decode(SessionEndReason.self, forKey: .reason))
    case "error":
      self = .error(code: try c.decode(ErrorCode.self, forKey: .code),
                    message: try c.decodeIfPresent(String.self, forKey: .message) ?? "",
                    recoverable: try c.decodeIfPresent(Bool.self, forKey: .recoverable) ?? true)
    default:
      self = .unknown(type: type)
    }
  }
}

// MARK: - REST DTOs (DESIGN.md §4.1 — POST /api/devices/claim)

struct ClaimRequest: Encodable {
  var code: String
  var deviceType: DeviceType = .glassesBridge
  var name: String
}

struct ClaimResponse: Decodable, Equatable {
  var deviceId: String
  var deviceToken: String
}

// MARK: - One coder pair for the app

enum Wire {
  static let encoder = JSONEncoder()
  static let decoder = JSONDecoder()

  static func encode(_ msg: DeviceToCortex) -> String {
    // Encoding a value type of our own enum cannot fail in practice; fall back to {} rather than crash a stream.
    String(decoding: (try? encoder.encode(msg)) ?? Data("{}".utf8), as: UTF8.self)
  }

  static func decode(_ text: String) throws -> CortexToDevice {
    try decoder.decode(CortexToDevice.self, from: Data(text.utf8))
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task2 --filter ProtocolTests`
Expected: `Executed 14 tests, with 0 failures`. (License pending → `swift build --scratch-path /tmp/wingman-build-task2` must print `Build complete!` and the report says tests not executed.)

- [ ] **Step 5: Commit**

```bash
git add glassbridge/Wingman/Protocol.swift glassbridge/WingmanTests/ProtocolTests.swift
git commit -m "glassbridge: Protocol.swift hand-mirror of DESIGN.md §4.2 + round-trip tests

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 3: FrameSampler — cadence, downscale, JPEG, frame/photo emission

**Files:**
- Create: `glassbridge/Wingman/FrameSampler.swift`
- Create: `glassbridge/WingmanTests/FrameSamplerTests.swift`

**Interfaces:**
- Consumes: `ArmedConfig`, `DeviceToCortex` (Task 2).
- Produces:
  - `enum FrameEncoder { static func scaled(_ image: CGImage, maxEdge: Int) -> CGImage; static func jpeg(_ image: CGImage, quality: Double) -> Data?; static func encodeFrame(_ image: CGImage, maxEdge: Int, quality: Double = 0.6) -> Data?; static func decode(_ data: Data) -> CGImage? }`
  - `final class FrameSampler { init(config: ArmedConfig = .defaults, send: @escaping (DeviceToCortex) -> Void); private(set) var config: ArmedConfig; private(set) var seq: Int; private(set) var isRunning: Bool; func apply(_ config: ArmedConfig); func start(); func stop(); func offer(_ image: CGImage, now: Date = Date()); func handlePhoto(reqId: String, data: Data); func photoFailed(reqId: String, reason: String); func drain() }`
  - `send` is invoked on the sampler's private serial queue (callers hop to main themselves if needed).

- [ ] **Step 1: Write the failing tests `glassbridge/WingmanTests/FrameSamplerTests.swift`**

```swift
import XCTest
import CoreGraphics
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
    let sampler = FrameSampler(config: .defaults) { sent.append($0) }
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task3 --filter FrameSamplerTests`
Expected: compile error "cannot find 'FrameSampler' in scope".

- [ ] **Step 3: Write `glassbridge/Wingman/FrameSampler.swift`**

```swift
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task3 --filter FrameSamplerTests`
Expected: `Executed 8 tests, with 0 failures`. If `testFrameJpegIsUnder120KBAndDecodable` fails on size, the encoder is wrong (a 768×432 gradient at q0.6 is ~30 KB) — do not loosen the assertion.

- [ ] **Step 5: Commit**

```bash
git add glassbridge/Wingman/FrameSampler.swift glassbridge/WingmanTests/FrameSamplerTests.swift
git commit -m "glassbridge: FrameSampler (cadence, downscale, JPEG, photo) + tests

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 4: HudRenderer — RenderCoalescer (≥ renderMinGapMs, latest wins) + DAT FlexBox mapping

**Files:**
- Create: `glassbridge/Wingman/HudRenderer.swift`
- Create: `glassbridge/WingmanTests/HudRendererTests.swift`

**Interfaces:**
- Consumes: `HudCard`, `ArmedConfig` (Task 2). DAT: `Display.send(_ view: some DisplayableView) async throws`, `FlexBox`, `Text(_:style:color:)`, `EdgeInsets(all:)` per `docs/dat-0.9.0-api-notes.md` §6.
- Produces:
  - `final class RenderCoalescer { init(minGapMs: Int = 500, queue: DispatchQueue = .main, draw: @escaping (HudCard) -> Void); var minGapMs: Int; func submit(_ card: HudCard); private(set) var drawCount: Int }`
  - `enum HudText { static let maxLines = 5; static let maxChars = 44; static func clip(_ s: String, max: Int = maxChars) -> String; static func lines(of card: HudCard) -> [String] }`
  - iOS only (`#if canImport(MWDATDisplay)`): `final class HudRenderer { init(display: Display, minGapMs: Int); func apply(renderMinGapMs: Int); func render(_ card: HudCard); static func flexBox(for card: HudCard) -> FlexBox }`

- [ ] **Step 1: Write the failing tests `glassbridge/WingmanTests/HudRendererTests.swift`**

```swift
import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class HudRendererTests: XCTestCase {
  private func card(_ n: Int) -> HudCard { HudCard(cardId: "c", seq: n, kind: .company, title: "T\(n)") }

  /// DESIGN_MAC.md §2.4: burst 5 renders in 200 ms → ≤ 1 screen replace per 500 ms, last card wins.
  func testBurstCoalescesToFirstThenLatest() {
    let q = DispatchQueue(label: "test.coalescer")
    var drawn: [HudCard] = []
    let c = RenderCoalescer(minGapMs: 500, queue: q) { drawn.append($0) }
    for i in 1...5 { c.submit(card(i)); Thread.sleep(forTimeInterval: 0.04) }   // 5 submits in ~200 ms
    Thread.sleep(forTimeInterval: 0.9)
    q.sync {}
    XCTAssertEqual(drawn.map(\.seq), [1, 5])
  }

  func testSpacedSubmitsDrawImmediately() {
    let q = DispatchQueue(label: "test.coalescer2")
    var drawn: [Int] = []
    let c = RenderCoalescer(minGapMs: 100, queue: q) { drawn.append($0.seq) }
    c.submit(card(1)); Thread.sleep(forTimeInterval: 0.15)
    c.submit(card(2)); Thread.sleep(forTimeInterval: 0.15)
    q.sync {}
    XCTAssertEqual(drawn, [1, 2])
  }

  func testMinGapCanBeRetunedAtRuntime() {
    let q = DispatchQueue(label: "test.coalescer3")
    var drawn: [Int] = []
    let c = RenderCoalescer(minGapMs: 2000, queue: q) { drawn.append($0.seq) }
    c.minGapMs = 50
    c.submit(card(1)); Thread.sleep(forTimeInterval: 0.02); c.submit(card(2))
    Thread.sleep(forTimeInterval: 0.2); q.sync {}
    XCTAssertEqual(drawn, [1, 2])
  }

  func testClipNeverExceedsMaxAndEndsWithEllipsis() {
    XCTAssertEqual(HudText.clip("short"), "short")
    let long = String(repeating: "x", count: 60)
    XCTAssertEqual(HudText.clip(long).count, 44)
    XCTAssertTrue(HudText.clip(long).hasSuffix("…"))
  }

  func testLinesCappedAtFive() {
    var c = card(1); c.lines = (1...8).map { "line \($0)" }
    XCTAssertEqual(HudText.lines(of: c).count, 5)
    c.lines = nil
    XCTAssertEqual(HudText.lines(of: c), [])
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task4 --filter HudRendererTests`
Expected: compile error "cannot find 'RenderCoalescer' in scope".

- [ ] **Step 3: Write `glassbridge/Wingman/HudRenderer.swift`**

```swift
// HudRenderer.swift — HudCard → DAT declarative display (DESIGN.md §4.2 renderer contract, §5.1 responsibility 3).
// The DAT display has NO partial updates: every send() replaces the whole 600×600 screen, so renders are
// coalesced to ≥ renderMinGapMs apart, always drawing the LATEST card. Devices are stateless renderers —
// Cortex owns rotation timing; same cardId + higher seq simply replaces the screen.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator — render messages + armed.config.renderMinGapMs (shared/src/constants.ts RENDER_MIN_GAP_MS)
// CONTRACT: DESIGN.md §4.2 render / HudCard (title + subtitle + ≤ 5 lines ≈ 40 chars + footer) and Appendix D renderMinGapMs
// AT-INTEGRATION: verify the received armed.config.renderMinGapMs overrides the compiled 500 ms default (BridgeController logs both on arm); check card typography on-lens at M2.
//
// INTEGRATION: HudRenderer
// IN:  render(HudCard) from BridgeController on every `render` message; apply(renderMinGapMs:) on `armed`
// OUT: display.send(FlexBox) on the DAT Display (main queue), at most one per renderMinGapMs
// WIRE: HudRenderer(display: dat.display, minGapMs: config.renderMinGapMs) after DATSessionManager.start()

import Foundation

// MARK: - Platform-neutral half (tested on macOS)

/// Coalesces draw requests: draws immediately when ≥ minGapMs since the last draw, otherwise
/// schedules ONE deferred draw at lastDraw + minGapMs carrying whatever card is newest by then.
final class RenderCoalescer {
  var minGapMs: Int
  private(set) var drawCount = 0
  private let queue: DispatchQueue
  private let draw: (HudCard) -> Void
  private var lastDraw = Date.distantPast
  private var pending: HudCard?
  private var timerArmed = false

  init(minGapMs: Int = ArmedConfig.defaults.renderMinGapMs, queue: DispatchQueue = .main, draw: @escaping (HudCard) -> Void) {
    self.minGapMs = minGapMs
    self.queue = queue
    self.draw = draw
  }

  func submit(_ card: HudCard) {
    queue.async {
      let now = Date()
      let elapsedMs = now.timeIntervalSince(self.lastDraw) * 1000
      if elapsedMs >= Double(self.minGapMs) && self.pending == nil {
        self.lastDraw = now
        self.drawCount += 1
        self.draw(card)
        return
      }
      self.pending = card                                  // latest wins
      guard !self.timerArmed else { return }
      self.timerArmed = true
      let delay = max(0, Double(self.minGapMs) / 1000 - elapsedMs / 1000)
      self.queue.asyncAfter(deadline: .now() + delay) {
        self.timerArmed = false
        guard let c = self.pending else { return }
        self.pending = nil
        self.lastDraw = Date()
        self.drawCount += 1
        self.draw(c)
      }
    }
  }
}

/// Defensive clipping so a card can never wrap-scroll on the 600×600 lens (Cortex enforces limits upstream).
enum HudText {
  static let maxLines = 5
  static let maxChars = 44   // contract says ≈ 40; small slack, then hard clip

  static func clip(_ s: String, max: Int = maxChars) -> String {
    s.count <= max ? s : String(s.prefix(max - 1)) + "…"
  }

  static func lines(of card: HudCard) -> [String] {
    (card.lines ?? []).prefix(maxLines).map { clip($0) }
  }
}

// MARK: - DAT half (iOS app target only). Keep SwiftUI OUT of this file: DAT's Text/Image collide with SwiftUI's.

#if canImport(MWDATDisplay)
import MWDATDisplay

final class HudRenderer {
  private let display: Display
  private let coalescer: RenderCoalescer

  init(display: Display, minGapMs: Int = ArmedConfig.defaults.renderMinGapMs) {
    self.display = display
    self.coalescer = RenderCoalescer(minGapMs: minGapMs, queue: .main) { card in
      Task {
        do { try await display.send(HudRenderer.flexBox(for: card)) }
        catch { NSLog("HudRenderer: display.send failed for \(card.cardId)#\(card.seq): \(error)") }
      }
    }
  }

  func apply(renderMinGapMs: Int) { DispatchQueue.main.async { self.coalescer.minGapMs = renderMinGapMs } }

  func render(_ card: HudCard) { coalescer.submit(card) }

  /// title (heading) / subtitle (secondary) / ≤ 5 lines (body) / footer (meta, secondary). Root must be a FlexBox.
  static func flexBox(for card: HudCard) -> FlexBox {
    FlexBox(direction: .column, spacing: 6, alignment: .start, crossAlignment: .stretch, padding: EdgeInsets(all: 24)) {
      Text(HudText.clip(card.title, max: 28), style: .heading)
      if let subtitle = card.subtitle { Text(HudText.clip(subtitle), style: .body, color: .secondary) }
      for line in HudText.lines(of: card) { Text(line, style: .body) }
      if let footer = card.footer { Text(HudText.clip(footer), style: .meta, color: .secondary) }
    }
  }
}
#endif
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task4 --filter HudRendererTests`
Expected: `Executed 5 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add glassbridge/Wingman/HudRenderer.swift glassbridge/WingmanTests/HudRendererTests.swift
git commit -m "glassbridge: HudRenderer (render coalescing ≥ renderMinGapMs, DAT FlexBox mapping) + tests

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 5: CortexSocket (WS + reconnect + heartbeat), LinkClient (claim), Keychain

**Files:**
- Create: `glassbridge/Wingman/CortexSocket.swift`
- Create: `glassbridge/Wingman/LinkClient.swift`
- Create: `glassbridge/Wingman/Keychain.swift`
- Create: `glassbridge/WingmanTests/CortexSocketTests.swift`
- Create: `glassbridge/WingmanTests/ConfigTests.swift`

**Interfaces:**
- Consumes: `DeviceToCortex`, `CortexToDevice`, `Wire`, `DeviceType`, `DeviceCaps`, `ClaimRequest`, `ClaimResponse` (Task 2); `Config.httpOrigin(of:)` (Task 1).
- Produces:
  - `final class CortexSocket { enum State: Equatable { disconnected, connecting, connected }; init(url: URL, token: String, deviceType: DeviceType = .glassesBridge, caps: DeviceCaps = DeviceCaps(video: true, photoHiRes: true)); var onMessage: ((CortexToDevice) -> Void)?; var onState: ((State) -> Void)?; var batteryProvider: (() -> Double?)?; var heartbeatInterval: TimeInterval; var maxBackoff: TimeInterval; private(set) var state: State; private(set) var wantsSession: Bool; func connect(); func disconnect(); func startSession(); func stopSession(); func send(_ msg: DeviceToCortex) }` — `onMessage`/`onState` are delivered on the main queue.
  - `enum LinkError: Error, LocalizedError { http(Int, String), transport(Error) }`; `enum LinkClient { static func claim(baseURL: URL, code: String, name: String) async throws -> ClaimResponse }`
  - `enum Keychain { static func set(_ value: String, for key: String); static func get(_ key: String) -> String?; static func delete(_ key: String) }`; key constants `Keychain.deviceTokenKey = "deviceToken"`, `Keychain.deviceIdKey = "deviceId"`.

- [ ] **Step 1: Write the failing tests**

`glassbridge/WingmanTests/ConfigTests.swift`:
```swift
import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class ConfigTests: XCTestCase {
  func testHttpOriginFromWsURL() {
    XCTAssertEqual(Config.httpOrigin(of: URL(string: "ws://192.168.1.23:8787/ws/device")!).absoluteString, "http://192.168.1.23:8787")
    XCTAssertEqual(Config.httpOrigin(of: URL(string: "wss://wingman-cortex.fly.dev/ws/device")!).absoluteString, "https://wingman-cortex.fly.dev")
  }
}
```

`glassbridge/WingmanTests/CortexSocketTests.swift` — a minimal WebSocket server on `Network.framework` lives in the test file so the test needs no Node and no phone:
```swift
import XCTest
import Network
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

/// Tiny WS echo-less server: records text frames it receives, can push text frames, can be killed.
final class TestWSServer {
  let port: UInt16
  private var listener: NWListener?
  private var conns: [NWConnection] = []
  private let lock = NSLock()
  private var _received: [String] = []
  var received: [String] { lock.lock(); defer { lock.unlock() }; return _received }
  var connectionCount = 0

  init(port: UInt16) { self.port = port }

  func start() throws {
    let params = NWParameters.tcp
    let ws = NWProtocolWebSocket.Options()
    ws.autoReplyPing = true
    params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
    let ready = DispatchSemaphore(value: 0)
    l.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
    l.newConnectionHandler = { [weak self] c in self?.accept(c) }
    l.start(queue: .global())
    XCTAssertEqual(ready.wait(timeout: .now() + 5), .success)
    listener = l
  }

  private func accept(_ c: NWConnection) {
    lock.lock(); conns.append(c); connectionCount += 1; lock.unlock()
    c.start(queue: .global())
    receive(c)
  }

  private func receive(_ c: NWConnection) {
    c.receiveMessage { [weak self] data, _, _, error in
      guard let self else { return }
      if let d = data, let s = String(data: d, encoding: .utf8) { self.lock.lock(); self._received.append(s); self.lock.unlock() }
      if error == nil { self.receive(c) }
    }
  }

  func sendText(_ s: String) {
    let md = NWProtocolWebSocket.Metadata(opcode: .text)
    let ctx = NWConnection.ContentContext(identifier: "text", metadata: [md])
    lock.lock(); let cs = conns; lock.unlock()
    for c in cs { c.send(content: s.data(using: .utf8), contentContext: ctx, isComplete: true, completion: .idempotent) }
  }

  func stop() {
    lock.lock(); let cs = conns; conns = []; lock.unlock()
    cs.forEach { $0.cancel() }
    listener?.cancel(); listener = nil
  }

  /// Poll until `received` satisfies the predicate.
  @discardableResult
  func wait(timeout: TimeInterval = 10, until pred: ([String]) -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if pred(received) { return true }
      RunLoop.main.run(until: Date().addingTimeInterval(0.05))   // pump so onState/onMessage (main queue) run
    }
    return pred(received)
  }
}

final class CortexSocketTests: XCTestCase {
  private func types(_ msgs: [String]) -> [String] {
    msgs.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])?["type"] as? String }
  }

  func testHandshakeSendsHelloThenSessionStartAndAppendsToken() throws {
    let port = UInt16.random(in: 20000...40000)
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "tok123")
    sock.connect(); sock.startSession()
    XCTAssertTrue(server.wait { self.types($0) == ["hello", "session_start"] }, "got \(server.received)")
    let hello = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(server.received[0].utf8)) as? [String: Any])
    XCTAssertEqual(hello["deviceType"] as? String, "glasses_bridge")
    XCTAssertEqual((hello["caps"] as? [String: Any])?["video"] as? Bool, true)
    sock.disconnect()
  }

  func testDeliversDecodedMessagesOnMain() throws {
    let port = UInt16.random(in: 20000...40000)
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
    let exp = expectation(description: "armed")
    var got: CortexToDevice?
    sock.onMessage = { m in XCTAssertTrue(Thread.isMainThread); got = m; exp.fulfill() }
    sock.connect()
    XCTAssertTrue(server.wait { !$0.isEmpty })
    server.sendText(#"{ "type": "armed", "sessionId": "s_42" }"#)
    wait(for: [exp], timeout: 5)
    XCTAssertEqual(got, .armed(sessionId: "s_42", config: nil))
    sock.disconnect()
  }

  /// DESIGN_MAC.md §2.3: kill/restart the harness → socket reconnects and re-sends session_start.
  func testReconnectsAfterServerRestartAndResendsSessionStart() throws {
    let port = UInt16.random(in: 20000...40000)
    var server = TestWSServer(port: port); try server.start()
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
    sock.maxBackoff = 2
    var states: [CortexSocket.State] = []
    sock.onState = { states.append($0) }
    sock.connect(); sock.startSession()
    XCTAssertTrue(server.wait { self.types($0) == ["hello", "session_start"] })
    server.stop()
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    XCTAssertTrue(server.wait(timeout: 15) { self.types($0).contains("session_start") }, "no reconnect: \(server.received)")
    let t = types(server.received)
    XCTAssertEqual(t.prefix(2), ["hello", "session_start"])
    XCTAssertTrue(t.contains("status"), "expected a status note=reconnected, got \(t)")
    XCTAssertTrue(server.received.contains { $0.contains("\"reconnected\"") })
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    XCTAssertTrue(states.contains(.disconnected), "states: \(states)")
    sock.disconnect()
  }

  func testSendWhileDisconnectedIsDroppedNotQueued() throws {
    let port = UInt16.random(in: 20000...40000)
    let sock = CortexSocket(url: URL(string: "ws://127.0.0.1:\(port)/ws/device")!, token: "t")
    sock.send(.frame(seq: 1, ts: 0, dataBase64: ""))     // no server, no connect → must not crash, must not queue
    let server = TestWSServer(port: port); try server.start(); defer { server.stop() }
    sock.connect()
    XCTAssertTrue(server.wait { self.types($0) == ["hello"] })
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    XCTAssertEqual(types(server.received), ["hello"])
    sock.disconnect()
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task5 --filter 'CortexSocketTests|ConfigTests'`
Expected: compile error "cannot find 'CortexSocket' in scope".

- [ ] **Step 3: Write `glassbridge/Wingman/Keychain.swift`**

```swift
// Keychain.swift — deviceToken/deviceId storage (DESIGN.md §5.1 responsibility 1). Generic-password items,
// readable after first unlock so a locked phone can still reconnect.
import Foundation
import Security

enum Keychain {
  static let deviceTokenKey = "deviceToken"
  static let deviceIdKey = "deviceId"
  private static let service = "com.hackrice.wingman"

  private static func base(_ key: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: key]
  }

  static func set(_ value: String, for key: String) {
    SecItemDelete(base(key) as CFDictionary)
    var add = base(key)
    add[kSecValueData as String] = Data(value.utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let status = SecItemAdd(add as CFDictionary, nil)
    if status != errSecSuccess { NSLog("Keychain.set(\(key)) failed: \(status)") }
  }

  static func get(_ key: String) -> String? {
    var q = base(key)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }

  static func delete(_ key: String) { SecItemDelete(base(key) as CFDictionary) }
}
```

- [ ] **Step 4: Write `glassbridge/Wingman/LinkClient.swift`**

```swift
// LinkClient.swift — the one REST call GlassBridge makes: POST /api/devices/claim (DESIGN.md §4.1, §5.1 responsibility 1).
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/rest/routes.ts — POST /api/devices/link-code (dashboard shows the code) + POST /api/devices/claim
// CONTRACT: DESIGN.md §4.1 — { code, deviceType: "glasses_bridge", name } → { deviceId, deviceToken }
// AT-INTEGRATION: run the code→claim flow once against live Cortex from StatusView; token lands in Keychain; expect HTTP 404 (visible, recoverable in StatusView) until the Windows side deploys; then confirm the device appears in GET /api/devices.
//
// INTEGRATION: LinkClient
// IN:  baseURL (Config.cortexURL or Config.devHarnessHTTPURL), 6-digit code, device name
// OUT: ClaimResponse or LinkError(.http(status, body) / .transport)
// WIRE: BridgeController.link(code:) → Keychain.set(deviceToken/deviceId)

import Foundation

enum LinkError: Error, LocalizedError {
  case http(Int, String)
  case transport(Error)

  var errorDescription: String? {
    switch self {
    case let .http(status, body): return "Claim failed: HTTP \(status)\(status == 404 ? " — Cortex not deployed / route missing?" : "") \(body)"
    case let .transport(e): return "Claim failed: \(e.localizedDescription)"
    }
  }
}

enum LinkClient {
  static func claim(baseURL: URL, code: String, name: String, session: URLSession = .shared) async throws -> ClaimResponse {
    var req = URLRequest(url: baseURL.appendingPathComponent("api/devices/claim"))
    req.httpMethod = "POST"
    req.timeoutInterval = 10
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try Wire.encoder.encode(ClaimRequest(code: code, name: name))
    let data: Data, resp: URLResponse
    do { (data, resp) = try await session.data(for: req) } catch { throw LinkError.transport(error) }
    let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw LinkError.http(status, String(decoding: data.prefix(200), as: UTF8.self)) }
    return try Wire.decoder.decode(ClaimResponse.self, from: data)
  }
}
```

- [ ] **Step 5: Write `glassbridge/Wingman/CortexSocket.swift`**

```swift
// CortexSocket.swift — device WebSocket to Cortex (DESIGN.md §4.2, §5.1 responsibility 2): hello on open,
// session_start/stop, frames/photos up, cards down, auto-reconnect with backoff, status heartbeat.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/gateway/DeviceGateway.ts — WS upgrade on /ws/device + `?token=<deviceToken>` auth
// CONTRACT: DESIGN.md §4.2 — up: hello, session_start, session_stop, frame, photo, photo_error, status; down: armed, capture_photo, render, session_end, error
// AT-INTEGRATION: INTEGRATION-DAY: swap DEV_HARNESS_URL for CORTEX_WS_URL — BridgeController does this when Config.local.xcconfig holds a real URL and the StatusView "Use DevHarness" toggle is off. Then verify a `hello` with deviceType "glasses_bridge" arrives in Cortex logs after link.
//
// INTEGRATION: CortexSocket
// IN:  send(_:) from FrameSampler (frame/photo/photo_error) and BridgeController (session start/stop); batteryProvider for heartbeats
// OUT: onMessage(CortexToDevice) and onState(State), both on the main queue
// WIRE: CortexSocket(url: <ws url>, token: Keychain.get(Keychain.deviceTokenKey)!); connect() once linked; startSession() on Start

import Foundation

final class CortexSocket: NSObject, URLSessionWebSocketDelegate {
  enum State: Equatable { case disconnected, connecting, connected }

  var onMessage: ((CortexToDevice) -> Void)?
  var onState: ((State) -> Void)?
  var batteryProvider: (() -> Double?)?
  var heartbeatInterval: TimeInterval = 30
  var maxBackoff: TimeInterval = 15

  private(set) var state: State = .disconnected
  /// True between startSession() and stopSession(): session_start is re-sent after every (re)connect.
  private(set) var wantsSession = false

  private let url: URL
  private let deviceType: DeviceType
  private let caps: DeviceCaps
  private let q = DispatchQueue(label: "wingman.cortexsocket")
  private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
  private var task: URLSessionWebSocketTask?
  private var shouldRun = false
  private var attempts = 0
  private var everConnected = false
  private var heartbeat: DispatchSourceTimer?

  init(url: URL, token: String, deviceType: DeviceType = .glassesBridge,
       caps: DeviceCaps = DeviceCaps(video: true, photoHiRes: true)) {
    var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
    self.url = comps.url!
    self.deviceType = deviceType
    self.caps = caps
  }

  // MARK: public (thread-safe)

  func connect() { q.async { self.shouldRun = true; self.open() } }

  func disconnect() {
    q.async { self.shouldRun = false; self.wantsSession = false; self.teardown(); self.set(.disconnected) }
  }

  func startSession() { q.async { self.wantsSession = true; self.sendLocked(.sessionStart) } }
  func stopSession() { q.async { self.wantsSession = false; self.sendLocked(.sessionStop) } }
  func send(_ msg: DeviceToCortex) { q.async { self.sendLocked(msg) } }

  // MARK: internals — everything below runs on q

  private func open() {
    guard shouldRun, task == nil else { return }
    set(.connecting)
    let t = session.webSocketTask(with: url)
    task = t
    t.resume()
    receiveLoop(t)
  }

  /// Frames are ephemeral (DESIGN.md §8): when the socket is down they are dropped, never queued.
  private func sendLocked(_ msg: DeviceToCortex) {
    guard state == .connected, let t = task else { return }
    t.send(.string(Wire.encode(msg))) { [weak self] err in
      if err != nil { self?.q.async { self?.fail() } }
    }
  }

  private func receiveLoop(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      guard let self else { return }
      self.q.async {
        guard self.task === t else { return }
        switch result {
        case .success(let m):
          if case .string(let s) = m {
            if let msg = try? Wire.decode(s) { DispatchQueue.main.async { self.onMessage?(msg) } }
            else { NSLog("CortexSocket: undecodable message: \(s.prefix(120))") }
          }
          self.receiveLoop(t)
        case .failure:
          self.fail()
        }
      }
    }
  }

  private func fail() {
    guard task != nil else { return }
    teardown()
    set(.disconnected)
    scheduleReconnect()
  }

  private func teardown() {
    heartbeat?.cancel(); heartbeat = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
  }

  private func scheduleReconnect() {
    guard shouldRun else { return }
    let delay = min(maxBackoff, pow(2.0, Double(attempts))) + Double.random(in: 0...0.5)   // 1, 2, 4, 8, 15, 15…
    attempts += 1
    q.asyncAfter(deadline: .now() + delay) { self.open() }
  }

  private func set(_ s: State) {
    guard s != state else { return }
    state = s
    DispatchQueue.main.async { self.onState?(s) }
  }

  private func startHeartbeat() {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + heartbeatInterval, repeating: heartbeatInterval)
    t.setEventHandler { [weak self] in
      guard let self else { return }
      self.sendLocked(.status(battery: self.batteryProvider?(), note: nil))
      self.task?.sendPing { err in if err != nil { self.q.async { self.fail() } } }
    }
    t.resume()
    heartbeat = t
  }

  // MARK: URLSessionWebSocketDelegate (called on URLSession's queue → hop to q)

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    q.async {
      guard webSocketTask === self.task else { return }
      let reconnected = self.everConnected
      self.everConnected = true
      self.attempts = 0
      self.set(.connected)
      self.sendLocked(.hello(deviceType: self.deviceType, caps: self.caps))
      if self.wantsSession { self.sendLocked(.sessionStart) }
      if reconnected { self.sendLocked(.status(battery: self.batteryProvider?(), note: "reconnected")) }
      self.startHeartbeat()
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                  didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    q.async { guard webSocketTask === self.task else { return }; self.fail() }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    q.async { guard task === self.task else { return }; self.fail() }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task5 --filter 'CortexSocketTests|ConfigTests'`
Expected: `Executed 5 tests, with 0 failures`. The reconnect test takes ~2–4 s (first retry after ~1 s).

- [ ] **Step 7: Commit**

```bash
git add glassbridge/Wingman/CortexSocket.swift glassbridge/Wingman/LinkClient.swift glassbridge/Wingman/Keychain.swift \
  glassbridge/WingmanTests/CortexSocketTests.swift glassbridge/WingmanTests/ConfigTests.swift
git commit -m "glassbridge: CortexSocket (WS, reconnect, heartbeat), LinkClient claim, Keychain + tests

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 6: DevHarness — fake Cortex (HTTP claim + WS) with scripted cards, plus a fake device

**Files:**
- Create: `glassbridge/DevHarness/package.json`
- Create: `glassbridge/DevHarness/harness.mjs`
- Create: `glassbridge/DevHarness/fake-device.mjs`

**Interfaces:**
- Consumes: the wire shapes of DESIGN.md §4.2/§4.1 (transcribe from DESIGN.md, not from `cortex/`).
- Produces: `node harness.mjs [--port 8787] [--interval 1750] [--end 90] [--burst] [--save]` serving `POST /api/devices/claim` and `GET /ws/device?token=…` on ONE port; `node fake-device.mjs [ws://localhost:8787/ws/device] [token]`.

- [ ] **Step 1: Write `glassbridge/DevHarness/package.json`**

```json
{
  "name": "wingman-devharness",
  "private": true,
  "type": "module",
  "description": "Fake Cortex for GlassBridge (DESIGN_MAC.md §1). Not a pnpm workspace member — run `npm install` here.",
  "scripts": { "start": "node harness.mjs", "device": "node fake-device.mjs" },
  "dependencies": { "ws": "^8.18.0" }
}
```

- [ ] **Step 2: Write `glassbridge/DevHarness/harness.mjs`**

```js
#!/usr/bin/env node
// harness.mjs — a fake Cortex for GlassBridge (DESIGN_MAC.md §1 "DevHarness"). Plain node + `ws`.
//   * POST /api/devices/claim  → { deviceId, deviceToken }   (code "000000" → 404, to exercise the error path)
//   * GET  /ws/device?token=…  → validates every device→cortex message against DESIGN.md §4.2 shapes, logs cadence
//                                and sizes, and replays the scripted card sequence after session_start.
// Shapes below are transcribed from DESIGN.md §4.2 — NEVER from cortex/ source (merge contract §0.2).
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: the real Cortex (cortex/src/index.ts on Fly.io) replaces this whole file on integration day
// CONTRACT: DESIGN.md §4.1 /api/devices/claim, §4.2 device WebSocket
// AT-INTEGRATION: INTEGRATION-DAY: nothing to change here — stop using it: turn off "Use DevHarness" in StatusView (or set a real CORTEX_WS_URL).
import http from "node:http";
import fs from "node:fs";
import { WebSocketServer } from "ws";

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const PORT = Number(process.env.PORT ?? arg("--port", 8787));
const CONFIG = { frameIntervalMs: Number(arg("--interval", 1750)), frameMaxEdgePx: 768, docMaxEdgePx: 2048, renderMinGapMs: 500 }; // DESIGN.md Appendix D
const END_SEC = Number(arg("--end", 90));
const BURST = process.argv.includes("--burst");
const SAVE = process.argv.includes("--save");
if (SAVE) fs.mkdirSync("frames", { recursive: true });

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

// ---- DESIGN.md §4.2 device → cortex shapes: required keys and their JS types ----
const SHAPES = {
  hello: { deviceType: "string", caps: "object" },
  session_start: {},
  session_stop: {},
  frame: { seq: "number", ts: "number", mime: "string", dataBase64: "string" },
  photo: { reqId: "string", mime: "string", dataBase64: "string" },
  photo_error: { reqId: "string", reason: "string" },
  status: {},
};
function validate(msg) {
  const shape = SHAPES[msg.type];
  if (!shape) return `unknown type ${msg.type}`;
  for (const [k, t] of Object.entries(shape)) if (typeof msg[k] !== t) return `${msg.type}.${k} should be ${t}, got ${typeof msg[k]}`;
  if (msg.type === "hello" && !["glasses_bridge", "phone_web"].includes(msg.deviceType)) return `bad deviceType ${msg.deviceType}`;
  if ((msg.type === "frame" || msg.type === "photo") && msg.mime !== "image/jpeg") return `mime must be image/jpeg`;
  if (msg.type === "status" && msg.battery != null && (typeof msg.battery !== "number" || msg.battery < 0 || msg.battery > 1)) return `battery must be 0..1`;
  return null;
}

// ---- DESIGN.md §4.2 example cards, verbatim ----
const company = (seq, page, extraLines = []) => ({
  cardId: "c_007", seq, kind: "company", title: "Stripe",
  subtitle: "Payments infrastructure for the internet",
  lines: ["Hiring: SWE Intern, New Grad Backend", "Stack: Ruby, Go, ML infra at scale", "Recently: launched usage-based billing APIs", ...extraLines].slice(0, 5),
  footer: `Wingman · ${page}/2`, page: { index: page, count: 2 }, streaming: false,
  company: { companyId: "stripe", confidence: 0.93 }, minDisplaySec: 15,
});
const pitch = (seq) => ({
  cardId: "c_007", seq, kind: "pitch", title: "Stripe", subtitle: "Your pitch",
  lines: ["Built telemetry pipeline at Guadaloop", "Ask about usage-based billing infra", "TypeScript + Go — matches their stack"],
  footer: "Wingman · 2/2", page: { index: 2, count: 2 }, streaming: false, company: { companyId: "stripe", confidence: 0.93 },
});

// ---- HTTP: claim endpoint (DESIGN.md §4.1) ----
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/devices/claim") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let j = {}; try { j = JSON.parse(body); } catch {}
      log("claim", body);
      if (!/^\d{6}$/.test(j.code ?? "") || j.code === "000000") { res.writeHead(404, { "content-type": "application/json" }); return res.end(`{"error":"code not found"}`); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ deviceId: "dev_harness", deviceToken: "harness-token" }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

// ---- WS: device endpoint (DESIGN.md §4.2) ----
const wss = new WebSocketServer({ server, path: "/ws/device" });
wss.on("connection", (ws, req) => {
  const token = new URL(req.url, "http://x").searchParams.get("token");
  log(`WS connected token=${token ?? "MISSING"} from ${req.socket.remoteAddress}`);
  if (!token) { log("✗ no token → closing 4401"); return ws.close(4401, "missing token"); }

  let seq = 10, lastFrameAt = 0, frames = 0, timers = [], armed = false;
  const send = (m) => { ws.send(JSON.stringify(m)); log("→", m.type, m.card ? `${m.card.kind} ${m.card.cardId}#${m.card.seq} "${m.card.title}"` : m.reqId ?? m.sessionId ?? m.reason ?? ""); };
  const render = (card) => send({ type: "render", card });
  const at = (sec, fn) => timers.push(setTimeout(fn, sec * 1000));
  const endSession = (reason) => { timers.forEach(clearTimeout); timers = []; if (armed) { armed = false; send({ type: "session_end", reason }); } };

  const script = () => {
    at(1, () => render({ cardId: "c_007", seq: ++seq, kind: "ack", title: "Identifying…", footer: "Wingman" }));
    at(4, () => render(company(++seq, 1)));
    at(10, () => render(pitch(++seq)));
    at(16, () => render(company(++seq, 1)));                                  // rotation: same cardId, higher seq
    at(20, () => send({ type: "capture_photo", reqId: "r_18", quality: "document" }));
    at(26, () => send({ type: "error", code: "search_down", message: "harness: sample recoverable error", recoverable: true }));
    if (BURST) at(30, () => { for (let i = 0; i < 5; i++) setTimeout(() => render({ cardId: "burst", seq: i + 1, kind: "hint", title: `Burst ${i + 1}/5`, lines: ["≤ 1 replace per 500 ms", "last card wins"] }), i * 40); });
    let page = 2;
    for (let t = 28; t < END_SEC; t += 12) at(t, () => { render(page === 2 ? pitch(++seq) : company(++seq, 1)); page = page === 2 ? 1 : 2; });
    at(END_SEC, () => endSession("user_stop"));
  };

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return log("✗ non-JSON frame"); }
    const err = validate(msg);
    if (err) return log(`✗ INVALID ${msg.type ?? "?"}: ${err}`);
    switch (msg.type) {
      case "hello": log(`✓ hello ${msg.deviceType} caps=${JSON.stringify(msg.caps)}`); break;
      case "session_start":
        log("✓ session_start → armed"); armed = true; frames = 0; lastFrameAt = 0;
        send({ type: "armed", sessionId: "s_42", config: CONFIG }); script(); break;
      case "session_stop": log("✓ session_stop"); endSession("user_stop"); break;
      case "frame": {
        const bytes = Buffer.from(msg.dataBase64, "base64");
        const gap = lastFrameAt ? `${Date.now() - lastFrameAt} ms since last` : "first";
        lastFrameAt = Date.now(); frames++;
        const ok = bytes[0] === 0xff && bytes[1] === 0xd8;
        log(`${ok ? "✓" : "✗"} frame seq=${msg.seq} ${(bytes.length / 1024).toFixed(1)} KB${bytes.length > 120 * 1024 ? " (>120 KB target!)" : ""} ${gap}${ok ? "" : " NOT A JPEG"}`);
        if (SAVE) fs.writeFileSync(`frames/frame-${String(msg.seq).padStart(5, "0")}.jpg`, bytes);
        break;
      }
      case "photo": {
        const bytes = Buffer.from(msg.dataBase64, "base64");
        log(`✓ photo reqId=${msg.reqId} ${(bytes.length / 1024).toFixed(1)} KB`);
        if (SAVE) fs.writeFileSync(`frames/photo-${msg.reqId}.jpg`, bytes);
        render(company(++seq, 1, ["Roles: SWE Intern (Summer 2027)", "Deadline: Oct 15"]));   // scan merge
        break;
      }
      case "photo_error": log(`✓ photo_error reqId=${msg.reqId} reason=${msg.reason}`); break;
      case "status": log(`✓ status battery=${msg.battery ?? "-"} note=${msg.note ?? "-"}`); break;
    }
  });
  ws.on("close", (code) => { log(`WS closed ${code} after ${frames} frames`); timers.forEach(clearTimeout); });
});

server.listen(PORT, () => log(`DevHarness listening: ws://localhost:${PORT}/ws/device  http://localhost:${PORT}/api/devices/claim  config=${JSON.stringify(CONFIG)}${BURST ? " --burst" : ""}${SAVE ? " --save" : ""}`));
```

- [ ] **Step 3: Write `glassbridge/DevHarness/fake-device.mjs`**

```js
#!/usr/bin/env node
// fake-device.mjs — a scripted GlassBridge stand-in to exercise harness.mjs (and, on integration day, the
// real Cortex) without a phone: hello → session_start → one tiny JPEG frame per 1750 ms → answers capture_photo.
import WebSocket from "ws";

const URL_ = process.argv[2] ?? "ws://localhost:8787/ws/device";
const TOKEN = process.argv[3] ?? "harness-token";
// 1×1 white JPEG
const JPEG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const ws = new WebSocket(`${URL_}?token=${TOKEN}`);
const send = (m) => { ws.send(JSON.stringify(m)); log("→", m.type, m.seq ?? m.reqId ?? ""); };
let seq = 0, timer;
ws.on("open", () => {
  send({ type: "hello", deviceType: "glasses_bridge", caps: { video: true, photoHiRes: true } });
  send({ type: "session_start" });
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "armed") { log("← armed", m.sessionId, JSON.stringify(m.config)); clearInterval(timer); timer = setInterval(() => send({ type: "frame", seq: ++seq, ts: Date.now(), mime: "image/jpeg", dataBase64: JPEG }), m.config?.frameIntervalMs ?? 1750); }
  else if (m.type === "render") log("← render", m.card.kind, `${m.card.cardId}#${m.card.seq}`, JSON.stringify([m.card.title, m.card.subtitle, ...(m.card.lines ?? []), m.card.footer].filter(Boolean)));
  else if (m.type === "capture_photo") send({ type: "photo", reqId: m.reqId, mime: "image/jpeg", dataBase64: JPEG });
  else if (m.type === "session_end") { log("← session_end", m.reason); clearInterval(timer); ws.close(); }
  else log("←", m.type, JSON.stringify(m));
});
ws.on("close", (c) => { log("closed", c); process.exit(0); });
ws.on("error", (e) => { log("error", e.message); process.exit(1); });
```

- [ ] **Step 4: Run the self-check**

```bash
cd glassbridge/DevHarness && npm install
node harness.mjs --end 30 --burst > /tmp/harness.log 2>&1 &
sleep 1
curl -s -X POST localhost:8787/api/devices/claim -H 'content-type: application/json' -d '{"code":"483291","deviceType":"glasses_bridge","name":"t"}'; echo
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8787/api/devices/claim -H 'content-type: application/json' -d '{"code":"000000","deviceType":"glasses_bridge","name":"t"}'
timeout 40 node fake-device.mjs
kill %1; cat /tmp/harness.log
```
Expected: claim prints `{"deviceId":"dev_harness","deviceToken":"harness-token"}` then `404`; fake-device logs `← armed s_42 {…1750…}`, renders for ack, company, pitch, company (rotation), a `capture_photo` answered by `photo` and a merged company card with "Roles:" line, the 5-card burst, then `← session_end user_stop`. The harness log shows `✓ frame seq=N 0.3 KB ~1750 ms since last` lines and no `✗ INVALID`.

- [ ] **Step 5: Commit**

```bash
git add glassbridge/DevHarness/package.json glassbridge/DevHarness/harness.mjs glassbridge/DevHarness/fake-device.mjs
git commit -m "glassbridge: DevHarness fake Cortex (claim + WS + scripted cards) and fake device

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 7: AudioKeepalive — silent-audio lock survival

**Files:**
- Create: `glassbridge/Wingman/AudioKeepalive.swift`
- Create: `glassbridge/WingmanTests/SilentWavTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `enum SilentWav { static func url() -> URL }` (platform-neutral); iOS only: `final class AudioKeepalive { private(set) var isRunning: Bool; func start(); func stop() }`.

- [ ] **Step 1: Write the failing test `glassbridge/WingmanTests/SilentWavTests.swift`**

```swift
import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class SilentWavTests: XCTestCase {
  func testSilentWavIsValidPcmHeaderAndAllZeros() throws {
    let d = try Data(contentsOf: SilentWav.url())
    XCTAssertEqual(d.count, 44 + 16000)                                   // 1 s @ 8 kHz, mono, 16-bit
    XCTAssertEqual(String(decoding: d[0..<4], as: UTF8.self), "RIFF")
    XCTAssertEqual(String(decoding: d[8..<12], as: UTF8.self), "WAVE")
    XCTAssertEqual(String(decoding: d[36..<40], as: UTF8.self), "data")
    XCTAssertTrue(d[44...].allSatisfy { $0 == 0 })
  }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task7 --filter SilentWavTests`
Expected: compile error "cannot find 'SilentWav' in scope".

- [ ] **Step 3: Write `glassbridge/Wingman/AudioKeepalive.swift`**

```swift
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

final class AudioKeepalive {
  private(set) var isRunning = false
  private var player: AVAudioPlayer?
  private var interruptionObserver: NSObjectProtocol?

  func start() {
    guard !isRunning else { return }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      try session.setActive(true)
      let p = try AVAudioPlayer(contentsOf: SilentWav.url())
      p.numberOfLoops = -1
      p.volume = 1.0            // the file itself is silent; volume 0 can get the session deprioritized
      p.prepareToPlay()
      p.play()
      player = p
      isRunning = true
      // Phone call / Siri pauses us silently otherwise — restart when the interruption ends.
      interruptionObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
          guard let self, self.isRunning else { return }
          let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
          guard raw.flatMap(AVAudioSession.InterruptionType.init) == .ended else { return }
          try? AVAudioSession.sharedInstance().setActive(true)
          self.player?.play()
        }
      NSLog("AudioKeepalive: started")
    } catch {
      NSLog("AudioKeepalive: start failed: \(error)")
    }
  }

  func stop() {
    guard isRunning else { return }
    isRunning = false
    player?.stop(); player = nil
    if let o = interruptionObserver { NotificationCenter.default.removeObserver(o) }
    interruptionObserver = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    NSLog("AudioKeepalive: stopped")
  }
}
#endif
```

- [ ] **Step 4: Run to verify it passes**

Run: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test --scratch-path /tmp/wingman-build-task7 --filter SilentWavTests`
Expected: `Executed 1 test, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add glassbridge/Wingman/AudioKeepalive.swift glassbridge/WingmanTests/SilentWavTests.swift
git commit -m "glassbridge: AudioKeepalive (silent loop, .playback+.mixWithOthers, interruption restart)

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 8: DATSessionManager — ONE DeviceSession with camera stream + display

**Files:**
- Create: `glassbridge/Wingman/DATSessionManager.swift`

**Interfaces:**
- Consumes: DAT 0.9.0 API exactly as in `glassbridge/docs/dat-0.9.0-api-notes.md` §3–§6 (read it first; every identifier there is verbatim from the shipped `.swiftinterface`). Nothing from other tasks.
- Produces (iOS, `#if canImport(MWDATCore)`):
  ```swift
  @MainActor final class DATSessionManager: ObservableObject {
    @Published private(set) var registration: RegistrationState     // MWDATCore
    @Published private(set) var deviceName: String?
    @Published private(set) var sessionState: DeviceSessionState    // .idle … .stopped
    @Published private(set) var streamState: StreamState             // MWDATCamera
    @Published private(set) var displayState: DisplayState           // MWDATDisplay
    @Published private(set) var lastError: String?
    @Published private(set) var frameCount: Int
    var onFrame: ((CGImage) -> Void)?          // called OFF main, for every decoded frame
    var onPhoto: ((Data) -> Void)?             // full-res JPEG bytes from photoDataPublisher
    var onPhotoError: ((String) -> Void)?      // "capture_failed"
    private(set) var display: Display?
    static var isHardwareAvailable: Bool       // false in the Simulator
    func register() async
    func handleUrl(_ url: URL) async
    func start() async throws                  // session → started → camera(.raw, .high, 2 fps) → display
    func stop()
    func capturePhoto() -> Bool
  }
  ```
  On macOS / without DAT the file compiles to nothing (whole file inside `#if canImport(MWDATCore)`).

- [ ] **Step 1: Write `glassbridge/Wingman/DATSessionManager.swift`**

```swift
// DATSessionManager.swift — DESIGN.md §5.1: ONE DAT DeviceSession carrying BOTH the camera stream and the display.
// This combination is undocumented by Meta (docs/dat-0.9.0-api-notes.md §6 "Camera + Display on ONE session")
// and is exactly what the hour-zero hardware spike (BridgeController.runSpike) verifies. Display cannot be mocked
// (Mock Device Kit has no display model) — the display path is hardware-only.
//
// INTEGRATION: DATSessionManager
// IN:  start()/stop()/capturePhoto() from BridgeController; the Meta AI registration callback URL from App.onOpenURL
// OUT: onFrame(CGImage) off-main for every frame (FrameSampler.offer), onPhoto(Data) (FrameSampler.handlePhoto),
//      onPhotoError, `display` for HudRenderer, @Published states for StatusView
// WIRE: BridgeController owns one instance; App.swift calls Wearables.configure() before it is created.

#if canImport(MWDATCore)
import Foundation
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import UIKit
import MWDATCore
import MWDATCamera
import MWDATDisplay

/// File-scope so the off-main frame path can use it without touching MainActor state.
private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

@MainActor
final class DATSessionManager: ObservableObject {
  @Published private(set) var registration: RegistrationState = .unavailable
  @Published private(set) var deviceName: String?
  @Published private(set) var sessionState: DeviceSessionState = .idle
  @Published private(set) var streamState: StreamState = .stopped
  @Published private(set) var displayState: DisplayState = .stopped
  @Published private(set) var lastError: String?
  @Published private(set) var frameCount = 0

  var onFrame: ((CGImage) -> Void)?
  var onPhoto: ((Data) -> Void)?
  var onPhotoError: ((String) -> Void)?
  private(set) var display: Display?

  private let wearables = Wearables.shared
  private let selector: AutoDeviceSelector
  private var session: DeviceSession?
  private var camera: Camera?
  private let bag = ListenerTokenBag()

  static var isHardwareAvailable: Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    return true
    #endif
  }

  init() {
    // Build the selector EARLY so devicesStream has populated it before Start (api-notes §3 gotcha).
    selector = AutoDeviceSelector(wearables: wearables, filter: { $0.supportsDisplay() })
    registration = wearables.registrationState
    wearables.addRegistrationStateListener { [weak self] s in Task { @MainActor in self?.registration = s } }.store(in: bag)
    wearables.addDevicesListener { [weak self] ids in
      Task { @MainActor in self?.deviceName = ids.first.flatMap { self?.wearables.deviceForIdentifier($0)?.nameOrId() } }
    }.store(in: bag)
  }

  // MARK: registration (Meta AI round-trip, api-notes §2)

  func register() async {
    do { try await wearables.startRegistration() } catch { lastError = "Registration failed: \(error)" }
  }

  func handleUrl(_ url: URL) async {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
          c.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true else { return }
    do { _ = try await wearables.handleUrl(url) } catch { lastError = "handleUrl failed: \(error)" }
  }

  // MARK: session lifecycle — attach order per api-notes §6 "Correct attach order"

  func start() async throws {
    stop()
    lastError = nil
    let s = try wearables.createSession(deviceSelector: selector)
    session = s
    Task { for await st in s.stateStream() { await MainActor.run { self.sessionState = st } } }
    Task { for await e in s.errorStream() { await MainActor.run { self.lastError = "Session error: \(e)" } } }
    try s.start()
    for await st in s.stateStream() where st == .started || st == .stopped { if st == .stopped { throw DATError.sessionStopped }; break }

    // Camera permission is the only DAT permission (api-notes §3); it bounces through the Meta AI app.
    if try await wearables.checkPermissionStatus(.camera) != .granted {
      guard try await wearables.requestPermission(.camera) == .granted else { throw DATError.cameraDenied }
    }

    // Camera: raw frames (no HEVC decoding on our side), highest resolution, lowest legal fps — we sample every ~1.75 s anyway.
    let config = StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 2)
    guard let cam = try s.addCamera(config: config) else { throw DATError.cameraUnavailable }
    camera = cam
    let stream = cam.stream
    stream.statePublisher.listen { [weak self] st in Task { @MainActor in self?.streamState = st } }.store(in: bag)
    stream.videoFramePublisher.listen { [weak self] frame in
      guard let self, let img = Self.cgImage(from: frame) else { return }
      Task { @MainActor in self.frameCount += 1 }
      self.onFrame?(img)                                   // off-main by design: never block the DAT thread
    }.store(in: bag)
    stream.photoDataPublisher.listen { [weak self] photo in self?.onPhoto?(photo.data) }.store(in: bag)
    stream.errorPublisher.listen { [weak self] e in
      Task { @MainActor in
        self?.lastError = "Stream error: \(e)"
        if case .photoCaptureFailed = e { self?.onPhotoError?("capture_failed") }
      }
    }.store(in: bag)
    stream.start()

    // Display on the SAME session — the spike question.
    let d = try s.addDisplay()
    display = d
    d.statePublisher.listen { [weak self] st in Task { @MainActor in self?.displayState = st } }.store(in: bag)
    d.start()
  }

  func stop() {
    display?.onPlaybackEvent = nil
    display?.stop(); display = nil
    camera?.stop(); camera = nil
    session?.stop(); session = nil
    bag.clear()
    // Re-subscribe the two Wearables-level listeners cleared with the bag.
    wearables.addRegistrationStateListener { [weak self] s in Task { @MainActor in self?.registration = s } }.store(in: bag)
    wearables.addDevicesListener { [weak self] ids in
      Task { @MainActor in self?.deviceName = ids.first.flatMap { self?.wearables.deviceForIdentifier($0)?.nameOrId() } }
    }.store(in: bag)
  }

  /// Fire-and-forget; the JPEG arrives on onPhoto, failure on onPhotoError (api-notes §5).
  func capturePhoto() -> Bool {
    guard let cam = camera, streamState == .streaming else { return false }
    return cam.stream.capturePhoto(format: .jpeg)
  }

  // MARK: frame conversion (off-main)

  nonisolated private static func cgImage(from frame: VideoFrame) -> CGImage? {
    if let pb = CMSampleBufferGetImageBuffer(frame.sampleBuffer) {
      let ci = CIImage(cvPixelBuffer: pb)
      return ciContext.createCGImage(ci, from: ci.extent)
    }
    return frame.makeUIImage()?.cgImage       // fallback if the buffer is not a pixel buffer
  }
}

enum DATError: Error, LocalizedError {
  case sessionStopped, cameraDenied, cameraUnavailable
  var errorDescription: String? {
    switch self {
    case .sessionStopped: return "DAT session stopped before it started (glasses off / hinges closed / Developer Mode off?)"
    case .cameraDenied: return "Camera permission denied in the Meta AI app"
    case .cameraUnavailable: return "addCamera returned nil — session not .started"
    }
  }
}
#endif
```

- [ ] **Step 2: Compile check**

There is no macOS compile path for this file (it is `#if canImport(MWDATCore)`-guarded, so `swift build --scratch-path /tmp/wingman-build-task8` from `glassbridge/` must still print `Build complete!` — that proves the guard is right). The real compile happens in Task 10 with Xcode; re-read every DAT identifier you used against `docs/dat-0.9.0-api-notes.md` and list any you could not find there in your report as UNVERIFIED.

- [ ] **Step 3: Commit**

```bash
git add glassbridge/Wingman/DATSessionManager.swift
git commit -m "glassbridge: DATSessionManager — one DeviceSession with camera stream + display

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 9: BridgeController (wiring) + StatusView (the one screen) + hardware spike

**Files:**
- Create: `glassbridge/Wingman/BridgeController.swift`
- Create: `glassbridge/Wingman/StatusView.swift`

**Interfaces:**
- Consumes: everything from Tasks 1–8 by the exact names listed in their Interfaces blocks: `Config`, `Wire`/protocol types, `FrameSampler`, `FrameEncoder`, `HudRenderer`, `RenderCoalescer`, `CortexSocket`, `LinkClient`, `LinkError`, `Keychain`, `AudioKeepalive`, `DATSessionManager` (+ `App.swift` expects `BridgeController()` and `handleOpenURL(_:) async`).
- Produces: `@MainActor final class BridgeController: ObservableObject` and `struct StatusView: View` (reads it via `@EnvironmentObject`).

- [ ] **Step 1: Write `glassbridge/Wingman/BridgeController.swift`**

```swift
// BridgeController.swift — wires the dumb pipe together (DESIGN.md §5.1's four responsibilities) and owns all
// session state StatusView shows. No product logic: it forwards frames up and cards down.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator (armed / capture_photo / render / session_end) + DeviceGateway (WS)
// CONTRACT: DESIGN.md §4.2 message handling; Appendix D via armed.config
// AT-INTEGRATION: on every `armed` this logs "armed.config: compiled=<defaults> received=<config>" — verify the received values win (DESIGN_MAC.md required site for FrameSampler/HudRenderer).
//
// INTEGRATION: BridgeController
// IN:  StatusView actions (link/unlink/start/stop/spike/toggles); CortexSocket.onMessage; DATSessionManager.onFrame/onPhoto
// OUT: FrameSampler.offer/handlePhoto, HudRenderer.render, AudioKeepalive.start/stop, published state for StatusView
// WIRE: one instance created by App.swift as a @StateObject

import Foundation
import SwiftUI
#if canImport(MWDATDisplay)
import MWDATDisplay   // for `Display` in HudRendererBox; no DAT Text/Image is used in this file, so no SwiftUI clash
#endif

@MainActor
final class BridgeController: ObservableObject {
  enum LinkState: Equatable { case unlinked, linked(deviceId: String) }

  @Published private(set) var linkState: LinkState = .unlinked
  @Published private(set) var socketState: CortexSocket.State = .disconnected
  @Published private(set) var armed = false
  @Published private(set) var sessionId: String?
  @Published private(set) var lastError: String?
  @Published private(set) var lastCard: HudCard?
  @Published private(set) var framesSent = 0
  @Published private(set) var spikeResult: String?
  @Published var useDevHarness: Bool {
    didSet { UserDefaults.standard.set(useDevHarness, forKey: "useDevHarness"); reconnectIfLinked() }
  }

  #if canImport(MWDATCore)
  let dat = DATSessionManager()
  #endif
  private var socket: CortexSocket?
  private var sampler: FrameSampler!
  private var renderer: HudRendererBox?
  private let keepalive = AudioKeepalive()
  private var pendingPhotoReqId: String?
  private var simulatorFrameTimer: Timer?

  init() {
    useDevHarness = UserDefaults.standard.object(forKey: "useDevHarness") as? Bool ?? !Config.isCortexConfigured
    if let id = Keychain.get(Keychain.deviceIdKey), Keychain.get(Keychain.deviceTokenKey) != nil { linkState = .linked(deviceId: id) }
    sampler = FrameSampler { [weak self] msg in
      self?.socket?.send(msg)
      if case .frame = msg { Task { @MainActor in self?.framesSent += 1 } }
    }
    #if canImport(MWDATCore)
    dat.onFrame = { [weak self] img in self?.sampler.offer(img) }
    dat.onPhoto = { [weak self] data in Task { @MainActor in self?.photoArrived(data) } }
    dat.onPhotoError = { [weak self] reason in Task { @MainActor in self?.photoFailed(reason) } }
    #endif
    reconnectIfLinked()
  }

  var restBaseURL: URL { useDevHarness ? Config.devHarnessHTTPURL : Config.cortexURL }
  var wsURL: URL { useDevHarness ? Config.devHarnessWSURL : Config.cortexWSURL }

  // MARK: link (DESIGN.md §5.1 responsibility 1)

  func link(code: String) async {
    lastError = nil
    do {
      let r = try await LinkClient.claim(baseURL: restBaseURL, code: code, name: UIDevice.current.name)
      Keychain.set(r.deviceToken, for: Keychain.deviceTokenKey)
      Keychain.set(r.deviceId, for: Keychain.deviceIdKey)
      linkState = .linked(deviceId: r.deviceId)
      reconnectIfLinked()
    } catch {
      lastError = error.localizedDescription     // 404 until Cortex is deployed: visible + recoverable by design
    }
  }

  func unlink() {
    stop()
    socket?.disconnect(); socket = nil
    Keychain.delete(Keychain.deviceTokenKey); Keychain.delete(Keychain.deviceIdKey)
    linkState = .unlinked
  }

  /// The socket stays open whenever we are linked so a dashboard-initiated Start (armed pushed by Cortex) works.
  private func reconnectIfLinked() {
    socket?.disconnect(); socket = nil
    guard case .linked = linkState, let token = Keychain.get(Keychain.deviceTokenKey) else { return }
    let s = CortexSocket(url: wsURL, token: token)
    s.onState = { [weak self] st in self?.socketState = st }
    s.onMessage = { [weak self] m in self?.handle(m) }
    s.batteryProvider = { let b = UIDevice.current.batteryLevel; return b < 0 ? nil : Double(b) }
    s.connect()
    socket = s
  }

  // MARK: session (DESIGN.md §5.1 responsibility 2)

  func start() {
    lastError = nil
    guard socket != nil else { lastError = "Link the device first"; return }
    socket?.startSession()          // Cortex answers with `armed` → arm() does the hardware work
  }

  func stop() {
    socket?.stopSession()
    disarm()
  }

  private func arm(sessionId: String, config: ArmedConfig?) {
    let cfg = config ?? .defaults
    NSLog("armed.config: compiled=\(ArmedConfig.defaults) received=\(String(describing: config)) → using \(cfg)")
    self.sessionId = sessionId
    armed = true
    sampler.apply(cfg)
    sampler.start()
    keepalive.start()
    #if canImport(MWDATCore)
    if DATSessionManager.isHardwareAvailable {
      Task {
        do {
          try await dat.start()
          if let d = dat.display { renderer = HudRendererBox(display: d, minGapMs: cfg.renderMinGapMs) }
        } catch {
          lastError = "Glasses: \(error.localizedDescription)"
          socket?.send(.status(battery: nil, note: "dat_failed: \(error.localizedDescription)"))
        }
      }
    }
    #endif
    renderer?.apply(renderMinGapMs: cfg.renderMinGapMs)
  }

  private func disarm() {
    armed = false
    sessionId = nil
    sampler.stop()
    keepalive.stop()
    simulatorFrameTimer?.invalidate(); simulatorFrameTimer = nil
    #if canImport(MWDATCore)
    dat.stop()
    #endif
    renderer = nil
  }

  // MARK: Cortex → device (DESIGN.md §5.1 responsibility 3)

  private func handle(_ msg: CortexToDevice) {
    switch msg {
    case let .armed(sessionId, config):
      arm(sessionId: sessionId, config: config)
    case let .capturePhoto(reqId, _):
      pendingPhotoReqId = reqId
      #if canImport(MWDATCore)
      if !dat.capturePhoto() { photoFailed("capture_failed") }
      #else
      photoFailed("capture_failed")
      #endif
    case let .render(card):
      lastCard = card
      renderer?.render(card)
    case let .sessionEnd(reason):
      NSLog("session_end: \(reason)")
      disarm()
    case let .error(code, message, recoverable):
      lastError = "\(code.rawValue): \(message)\(recoverable ? "" : " (fatal)")"
    case let .unknown(type):
      NSLog("ignoring unknown message type \(type)")
    }
  }

  private func photoArrived(_ data: Data) {
    guard let reqId = pendingPhotoReqId else { return }
    pendingPhotoReqId = nil
    sampler.handlePhoto(reqId: reqId, data: data)
  }

  private func photoFailed(_ reason: String) {
    guard let reqId = pendingPhotoReqId else { return }
    pendingPhotoReqId = nil
    sampler.photoFailed(reqId: reqId, reason: reason)
  }

  func handleOpenURL(_ url: URL) async {
    #if canImport(MWDATCore)
    await dat.handleUrl(url)
    #endif
  }

  // MARK: debug helpers (Simulator-degraded path + hour-zero spike)

  /// Simulator: feed a synthetic frame once per second so FrameSampler/CortexSocket can be exercised without glasses.
  func startTestFrames() {
    simulatorFrameTimer?.invalidate()
    simulatorFrameTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self else { return }
      let img = UIGraphicsImageRenderer(size: CGSize(width: 1280, height: 720)).image { ctx in
        UIColor(hue: CGFloat(Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 10)) / 10, saturation: 0.6, brightness: 0.9, alpha: 1).setFill()
        ctx.fill(CGRect(x: 0, y: 0, width: 1280, height: 720))
        ("TEST FRAME \(Date())" as NSString).draw(at: CGPoint(x: 40, y: 40), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 48), .foregroundColor: UIColor.black])
      }.cgImage
      if let img { self.sampler.offer(img) }
    }
  }

  /// DESIGN.md §5.1 / DESIGN_MAC.md §2.1 hour-zero hardware spike: camera stream + display on ONE DeviceSession —
  /// wait for a real frame, then render a hello-world card. Independent of Cortex.
  func runSpike() async {
    spikeResult = "SPIKE running…"
    #if canImport(MWDATCore)
    guard DATSessionManager.isHardwareAvailable else { spikeResult = "SPIKE N/A in Simulator"; return }
    do {
      try await dat.start()
      let start = Date()
      while dat.frameCount == 0 && Date().timeIntervalSince(start) < 20 { try await Task.sleep(nanoseconds: 200_000_000) }
      guard dat.frameCount > 0 else { spikeResult = "SPIKE FAIL: no camera frame within 20 s (stream=\(dat.streamState)) \(dat.lastError ?? "")"; return }
      guard let d = dat.display else { spikeResult = "SPIKE FAIL: display not attached \(dat.lastError ?? "")"; return }
      let r = HudRendererBox(display: d, minGapMs: 500)
      r.render(HudCard(cardId: "spike", seq: 1, kind: .hint, title: "Wingman", subtitle: "hello, world",
                       lines: ["camera stream: OK (\(dat.frameCount) frames)", "display: sent"], footer: "hour-zero spike"))
      try await Task.sleep(nanoseconds: 3_000_000_000)
      spikeResult = "SPIKE OK: \(dat.frameCount) frames + card on lens? (check glasses) display=\(dat.displayState) \(dat.lastError ?? "")"
    } catch {
      spikeResult = "SPIKE FAIL: \(error.localizedDescription)"
    }
    #else
    spikeResult = "SPIKE N/A: DAT not linked"
    #endif
  }
}

/// Thin wrapper so BridgeController compiles when MWDATDisplay is absent (Simulator-only builds still link it, but keep the seam explicit).
final class HudRendererBox {
  #if canImport(MWDATDisplay)
  private let inner: HudRenderer
  init(display: Display, minGapMs: Int) { inner = HudRenderer(display: display, minGapMs: minGapMs) }
  func render(_ card: HudCard) { inner.render(card) }
  func apply(renderMinGapMs: Int) { inner.apply(renderMinGapMs: renderMinGapMs) }
  #else
  func render(_ card: HudCard) {}
  func apply(renderMinGapMs: Int) {}
  #endif
}
```

- [ ] **Step 2: Write `glassbridge/Wingman/StatusView.swift`**

```swift
// StatusView.swift — the ONE screen (DESIGN.md §5.1 responsibility 4): link state, connection dots, Start/Stop,
// battery, last error. Nothing else — plus Debug-only rows for the DevHarness toggle, the spike and test frames.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/rest/routes.ts POST /api/devices/claim (+ the console dashboard that shows the 6-digit code)
// CONTRACT: DESIGN.md §4.1 — { code, deviceType: "glasses_bridge", name } → { deviceId, deviceToken }
// AT-INTEGRATION: run once against live Cortex — type the dashboard code, tap Link; token lands in Keychain. Expect HTTP 404 (shown in "Last error", recoverable: just retry) until the Windows side deploys.

import SwiftUI

struct StatusView: View {
  @EnvironmentObject private var bridge: BridgeController
  @State private var code = ""

  var body: some View {
    NavigationStack {
      Form {
        Section("Link") {
          switch bridge.linkState {
          case .unlinked:
            TextField("6-digit code from dashboard", text: $code).keyboardType(.numberPad)
            Button("Link") { Task { await bridge.link(code: code) } }.disabled(code.count != 6)
          case let .linked(deviceId):
            LabeledContent("Device", value: deviceId)
            Button("Unlink", role: .destructive) { bridge.unlink() }
          }
        }

        Section("Connections") {
          dot("Cortex", state: bridge.socketState == .connected ? .green : bridge.socketState == .connecting ? .yellow : .red,
              text: "\(bridge.socketState)" + (bridge.useDevHarness ? " (DevHarness)" : ""))
          #if canImport(MWDATCore)
          dot("Glasses", state: bridge.dat.sessionState == .started ? .green : bridge.dat.sessionState == .starting ? .yellow : .gray,
              text: "\(bridge.dat.registration) · \(bridge.dat.deviceName ?? "no device") · session \(bridge.dat.sessionState)")
          dot("Stream", state: bridge.dat.streamState == .streaming ? .green : .gray, text: "\(bridge.dat.streamState)")
          dot("Display", state: bridge.dat.displayState == .started ? .green : .gray, text: "\(bridge.dat.displayState)")
          if bridge.dat.registration != .registered {
            Button("Register with Meta AI") { Task { await bridge.dat.register() } }
          }
          #endif
        }

        Section("Session") {
          if bridge.armed {
            Button("Stop", role: .destructive) { bridge.stop() }
            LabeledContent("Session", value: bridge.sessionId ?? "-")
          } else {
            Button("Start") { bridge.start() }.disabled(bridge.linkState == .unlinked)
          }
          LabeledContent("Frames sent", value: "\(bridge.framesSent)")
          LabeledContent("Battery", value: batteryText)
          if let card = bridge.lastCard {
            LabeledContent("Last card", value: "\(card.kind.rawValue) · \(card.title) (#\(card.seq))")
          }
        }

        if let err = bridge.lastError {
          Section("Last error") { Text(err).foregroundStyle(.red).font(.footnote) }
        }

        #if DEBUG
        Section("Debug") {
          Toggle("Use DevHarness", isOn: $bridge.useDevHarness)
          LabeledContent("WS", value: bridge.wsURL.absoluteString).font(.footnote)
          Button("Run hour-zero spike (camera + display)") { Task { await bridge.runSpike() } }
          if let r = bridge.spikeResult { Text(r).font(.footnote) }
          Button("Send test frames (Simulator)") { bridge.startTestFrames() }
        }
        #endif
      }
      .navigationTitle("Wingman")
    }
  }

  private var batteryText: String {
    let b = UIDevice.current.batteryLevel
    return b < 0 ? "-" : "\(Int(b * 100))%"
  }

  private func dot(_ label: String, state: Color, text: String) -> some View {
    HStack { Circle().fill(state).frame(width: 10, height: 10); Text(label); Spacer(); Text(text).foregroundStyle(.secondary).font(.footnote).lineLimit(1) }
  }
}
```

- [ ] **Step 3: Compile check**

`swift build --scratch-path /tmp/wingman-build-task9` from `glassbridge/` must still print `Build complete!` (both files are excluded from the macOS package). Cross-check every symbol used against the Interfaces blocks of Tasks 1–8 and list any mismatch in the report — the Xcode compile is Task 10.

- [ ] **Step 4: Commit**

```bash
git add glassbridge/Wingman/BridgeController.swift glassbridge/Wingman/StatusView.swift
git commit -m "glassbridge: BridgeController wiring + StatusView (link, dots, start/stop, spike)

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

### Task 10: Xcode gate — build, test, Package.resolved, README, INTEGRATION grep

**Files:**
- Modify: whatever fails to compile in `glassbridge/Wingman/*.swift` (minimal fixes only; no interface changes without a ledger ruling)
- Create: `glassbridge/Wingman.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` (generated)
- Modify: `glassbridge/README.md` (final)

**Interfaces:** none new.

- [ ] **Step 1: Resolve the DAT package and build for the Simulator**

```bash
cd glassbridge
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodegen generate
xcodebuild -resolvePackageDependencies -project Wingman.xcodeproj -scheme Wingman
grep -A3 meta-wearables-dat-ios Wingman.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved   # must show "version" : "0.9.0"
xcodebuild -project Wingman.xcodeproj -scheme Wingman -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`. Fix compile errors in place (DAT names: consult `docs/dat-0.9.0-api-notes.md`; if the notes are wrong, the `.swiftinterface` inside `~/Library/Developer/Xcode/DerivedData/*/SourcePackages/checkouts/meta-wearables-dat-ios/*.xcframework` is the truth — cite the line in the report).

- [ ] **Step 2: Run the unit tests both ways**

```bash
swift test --scratch-path /tmp/wingman-build-gate 2>&1 | tail -5
xcodebuild test -project Wingman.xcodeproj -scheme Wingman -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO 2>&1 | grep -E 'Test Suite|Executed|error' | tail -8
```
Expected: both report all tests passed (ProtocolTests 14, FrameSamplerTests 8, HudRendererTests 5, CortexSocketTests 4, ConfigTests 1, SilentWavTests 1, SmokeTests 1). If no `iPhone 16` simulator exists, use the first name from `xcrun simctl list devices available | grep iPhone`.

- [ ] **Step 3: Device build (compile only)**

```bash
xcodebuild -project Wingman.xcodeproj -scheme Wingman -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -5
```
Expected: `** BUILD SUCCEEDED **` (signing is skipped; the human's Personal Team signs the real install from Xcode).

- [ ] **Step 4: Verify the required INTEGRATION sites (DESIGN_MAC.md §0.7 table)**

```bash
grep -rn "INTEGRATION(X-MACHINE)" glassbridge --include=*.swift --include=*.xcconfig --include=*.mjs | cut -d: -f1 | sort -u
```
Expected files: `Wingman/Protocol.swift`, `Wingman/CortexSocket.swift`, `Config.xcconfig`, `Wingman/Config.swift`, `Wingman/StatusView.swift`, `Wingman/LinkClient.swift`, `Wingman/FrameSampler.swift`, `Wingman/HudRenderer.swift`, `Wingman/BridgeController.swift`, `Wingman/AudioKeepalive.swift`, `DevHarness/harness.mjs`. Each block must have the COUNTERPART / CONTRACT / AT-INTEGRATION lines; `grep -rn "INTEGRATION-DAY" glassbridge` must list the config swap and the URL fill.

- [ ] **Step 5: Finalize `glassbridge/README.md`**

Replace the stub with: (1) what this is + doc pointers; (2) **Human checklist** (verbatim from DESIGN_MAC.md §1.1: iPhone Developer Mode on (one reboot) · phone trusts the Mac · Meta AI app v272+ signed into the same Meta account as the developer enrollment · glasses firmware v125+, paired, Developer Mode toggled in the Meta AI app · tester enrollment done · Apple ID added in Xcode → Settings → Accounts, Personal Team; free provisioning expires in 7 days, re-sign demo morning); (3) **Build & run** (xcodegen, open project, select team via `Config.local.xcconfig` `DEVELOPMENT_TEAM`, Run to phone, trust prompt path Settings → General → VPN & Device Management); (4) **Tests** (`swift test` and `xcodebuild test` commands above); (5) **DevHarness** (npm install; `node harness.mjs --burst --save`; phone: set `DEV_HARNESS_URL` to the Mac's LAN IP in `Config.local.xcconfig`, keep "Use DevHarness" on; the six DESIGN_MAC.md §2 acceptance checks as a checklist with what to look for in the harness log — cadence ≈ frameIntervalMs, sizes ≤ 120 KB, reconnect after `kill`/restart re-sends session_start, every card kind renders, burst → ≤ 1 replace per 500 ms, 5-min locked-phone stream keeps frames flowing, claim against placeholder → visible 404); (6) **Hour-zero spike** (Debug → "Run hour-zero spike"; report SPIKE OK/FAIL to the human immediately; FAIL → DESIGN.md §6 cut line, no improvisation); (7) **Integration handoff** = the `grep -rn "INTEGRATION" glassbridge/` output pasted, plus the integration-day sequence from DESIGN_MAC.md §0.6.

- [ ] **Step 6: Commit**

```bash
git add glassbridge
git commit -m "glassbridge: Xcode build/test gate, Package.resolved (DAT 0.9.0), README handoff

Claude-Session: https://claude.ai/code/session_014A995iudhijhGmmP5yvEmz"
```

---

## Self-review notes (orchestrator)

- Spec coverage: §5.1 responsibilities 1–4 → Tasks 5/9 (link), 5/8/3/7 (session plumbing, sampling, keepalive), 3/4/8/9 (obey Cortex: photo + render), 9 (status screen). DESIGN_MAC.md §1 file list → every file has a task (Appendix B layout kept flat; `BridgeController.swift`, `LinkClient.swift`, `Keychain.swift` are the only additions, all inside `Wingman/`). §1.1 mechanics → Task 1 + 10. §2 acceptance checks → Task 6 (harness), Task 5 test (reconnect), Task 4 test (coalescing), README checklist (locked-phone, link 404, spike). Required INTEGRATION sites → Task 10 Step 4 verifies all six rows.
- Rulings embedded: `minDisplaySec` informational on device; DAT background modes added beyond `audio`; `NSAllowsLocalNetworking` in all configs; XCTest via SwiftPM shim; XcodeGen-generated project committed; Swift 5 language mode.
