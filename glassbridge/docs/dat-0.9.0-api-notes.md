# Meta Wearables Device Access Toolkit — iOS SDK 0.9.0 — code-level reference

**Version:** tag `0.9.0` EXISTS and is the latest tag. Commit `9b1b83d791dfebff7afd452e924a256819094b64`. Released **2026-08-03** (per `CHANGELOG.md`; the repo publishes tags only, no GitHub "Releases").
**Primary sources (all verbatim):**
- `https://raw.githubusercontent.com/facebook/meta-wearables-dat-ios/0.9.0/Package.swift`
- The shipped `.swiftinterface` files inside the tagged xcframeworks, e.g.
  `.../0.9.0/MWDATCore.xcframework/ios-arm64/MWDATCore.framework/Modules/MWDATCore.swiftmodule/arm64-apple-ios.swiftinterface`
  (same for `MWDATCamera`, `MWDATDisplay`, `MWDATMockDevice`, `MWDATMockDeviceTestClient`). **Every Swift signature below is copied from those files.**
- `main` branch: `plugins/mwdat-ios/skills/*/SKILL.md` (prose guidance), `samples/CameraAccess`, `samples/DisplayAccess`.
- `https://wearables.developer.meta.com/docs/develop/dat/...` (display-overview, display-ios, lifecycle-events, mock-device-kit).

Caveat: the `.swiftinterface` files are from the **0.9.0 tag** (authoritative for 0.9.0). Prose/skills/samples were read from **`main`**, which may be slightly ahead of 0.9.0. Where prose and the 0.9.0 interface disagree, the interface wins and I flag it.

---

## Executive summary — 10 most important facts

1. **Products to import:** `MWDATCore` (required), `MWDATCamera`, `MWDATDisplay`, `MWDATMockDevice`, `MWDATMockDeviceTestClient`. All five are **binary xcframeworks** (`.binaryTarget`), `swift-tools-version: 6.0`, built with `-swift-version 6 -enable-library-evolution`.
2. **Minimum iOS is 17.2** in 0.9.0 (bumped from 15.2). Module flags literally say `-target arm64-apple-ios17.2`. Your 17.2+ target is exactly the floor. `Package.swift` declares **no** `platforms:` clause.
3. **Simulator is supported** — every xcframework ships an `ios-arm64_x86_64-simulator` slice. Combined with `MWDATMockDevice`, the camera path runs fully in the simulator.
4. **One session, both capabilities:** `addCamera(config:)` (from `MWDATCamera`) and `addDisplay()` (from `MWDATDisplay`) are **both extensions on the same `MWDATCore.DeviceSession`**. Nothing in the API or docs forbids attaching both to one session; `DeviceSessionError.capabilityAlreadyActive` implies the guard is per-capability-type. **Coexistence is not documented anywhere — treat as UNVERIFIED, but it is the only shape the API supports.**
5. **Video frames are `CMSampleBuffer`**, delivered via `stream.videoFramePublisher.listen { (frame: VideoFrame) in ... }`. `VideoFrame.sampleBuffer: CMSampleBuffer` plus a convenience `frame.makeUIImage() -> sending UIImage?`. No `CVPixelBuffer` accessor is exposed.
6. **Photo capture is fire-and-forget + publisher:** `stream.capturePhoto(format: .jpeg | .heic) -> Bool`, result arrives on `stream.photoDataPublisher` as `PhotoData { let data: Data; let format: PhotoCaptureFormat }` (full-res encoded JPEG/HEIC bytes).
7. **Display is a declarative DSL with a result builder.** `try await display.send(_ view: some DisplayableView)`. Only `FlexBox` and `VideoPlayer` conform to `DisplayableView` (i.e. can be the root). `Text` / `Image` / `Icon` / `Button` / `ButtonGroup` conform only to `ViewComponent` and must live inside a `FlexBox`.
8. **Canvas is 600x600; every `send()` replaces the whole screen — there is no partial update.** Only one display capability per session. Display dims at 20s inactivity, sleeps at 25s (sleep does *not* end the session). Docs: "Users must explicitly initiate a display session."
9. **Registration is a Meta-AI round trip:** `try Wearables.configure()` at launch → `try await Wearables.shared.startRegistration()` (opens Meta AI) → your URL scheme gets called back → `try await Wearables.shared.handleUrl(url)`. Info.plist needs `MWDAT.AppLinkURLScheme` / `MetaAppID` / `ClientToken` / `TeamID`, a `CFBundleURLTypes` scheme, Bluetooth + local-network keys, and `NSBonjourServices`.
10. **Mock Device Kit supports camera + captouch only.** `GlassesModel` has **no** `metaRayBanDisplay` case and `MockGlassesServices` exposes only `{ camera, captouch }` → **you cannot mock the Display capability.** Real Ray-Ban Display hardware is required for section 6.

---

## 1. Package.swift — products, targets, platform

`Package.swift` at tag 0.9.0, verbatim structure:

```swift
// swift-tools-version: 6.0
let package = Package(
  name: "MetaWearablesDAT",
  products: [
    .library(name: "MWDATCamera",              targets: ["MWDATCamera"]),
    .library(name: "MWDATCore",                targets: ["MWDATCore"]),
    .library(name: "MWDATDisplay",             targets: ["MWDATDisplay"]),
    .library(name: "MWDATMockDevice",          targets: ["MWDATMockDevice"]),
    .library(name: "MWDATMockDeviceTestClient",targets: ["MWDATMockDeviceTestClient"]),
  ],
  targets: [
    .binaryTarget(name: "MWDATCamera",               path: "MWDATCamera.xcframework"),
    .binaryTarget(name: "MWDATCore",                 path: "MWDATCore.xcframework"),
    .binaryTarget(name: "MWDATDisplay",              path: "MWDATDisplay.xcframework"),
    .binaryTarget(name: "MWDATMockDevice",           path: "MWDATMockDevice.xcframework"),
    .binaryTarget(name: "MWDATMockDeviceTestClient", path: "MWDATMockDeviceTestClient.xcframework"),
  ]
)
```

- **Binary distribution.** Xcframeworks are committed *into the tag* (not into `main`, which holds only docs/samples). Each has `ios-arm64` and `ios-arm64_x86_64-simulator` slices.
- **No `platforms:` declaration.** The floor comes from the frameworks' module flags: `-target arm64-apple-ios17.2`. CHANGELOG 0.9.0 "Changed": *"[API] **Minimum deployment target bumped from iOS 15.2 to iOS 17.2.** Apps targeting older iOS versions can no longer link the SDK."*
- Objective-C interop is on (`-enable-objc-interop`); every Swift type has an `ObjC_`-prefixed bridge class exported as `MWDAT*`. Ignore the `ObjC_` types in a Swift app.
- For your app, add: **`MWDATCore` + `MWDATCamera` + `MWDATDisplay`**, and `MWDATMockDevice` (DEBUG only is the sample's pattern).

## 2. App setup — Info.plist, URL scheme, configure()

### Info.plist (copied from `samples/DisplayAccess/DisplayAccess/Info.plist`, marked "Begin/End required section for Device Access Toolkit Apps")

```xml
<key>CFBundleURLTypes</key>
<array><dict>
  <key>CFBundleTypeRole</key><string>Editor</string>
  <key>CFBundleURLName</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleURLSchemes</key><array><string>displaysample</string></array>
</dict></array>

<key>MWDAT</key>
<dict>
  <key>AppLinkURLScheme</key><string>displaysample://</string>   <!-- note trailing :// -->
  <key>MetaAppID</key>      <string>$(META_APP_ID)</string>      <!-- "0" in Developer Mode -->
  <key>ClientToken</key>    <string>$(CLIENT_TOKEN)</string>
  <key>TeamID</key>         <string>$(DEVELOPMENT_TEAM)</string>
</dict>

<key>UIBackgroundModes</key>
<array>
  <string>processing</string>
  <string>bluetooth-central</string>
  <string>bluetooth-peripheral</string>
  <!-- CameraAccess additionally has: <string>audio</string> -->
</array>

<key>NSBluetoothAlwaysUsageDescription</key><string>…</string>
<key>NSLocalNetworkUsageDescription</key><string>…</string>
<key>NSBonjourServices</key><array><string>_bonjour._tcp</string></array>
<!-- CameraAccess also: NSBluetoothPeripheralUsageDescription -->
```

Optional analytics / crash opt-outs (README): `MWDAT > Analytics > OptOut` (Bool) and `MWDAT > CrashReporting > OptOut` (Bool), both default `false` (= enabled).
Removed in 0.9.0: `MWDAT.DAMEnabled` is **ignored** — DAM is always on.

**Discrepancies between the skill docs and the shipped samples (decide deliberately):**
- `plugins/mwdat-ios/skills/getting-started/SKILL.md` tells you to add `UISupportedExternalAccessoryProtocols = ["com.meta.ar.wearable"]` and a `external-accessory` background mode, **and** to add `fb-viewapp` to the `LSApplicationQueriesSchemes` allowlist so the SDK can `canOpenURL` Meta AI. **Neither appears in either shipped sample's Info.plist.** UNVERIFIED which is actually required in 0.9.0; the samples are the safer ground truth, the skill's `fb-viewapp` note is the more plausible real requirement if `startRegistration()` silently fails.
- The skill doc claims "iOS 16.0+ deployment target" — **wrong for 0.9.0**, it is 17.2.

### Entitlements (from samples)
- Both: `keychain-access-groups = $(AppIdentifierPrefix)$(CFBundleIdentifier)`.
- CameraAccess only: `com.apple.developer.networking.HotspotConfiguration` = true, `com.apple.developer.networking.wifi-info` = true (Wi-Fi transport path added in 0.8.0).
- **No Meta-specific entitlement.** No `com.apple.external-accessory` entitlement in either sample.

### Configure + URL callback

```swift
import MWDATCore

@main struct MyApp: App {
  init() {
    do { try Wearables.configure() }      // throws(WearablesError): .internalError / .alreadyConfigured / .configurationError
    catch { NSLog("configure failed: \(error)") }
  }
}
```

`Wearables` is an enum namespace:
```swift
public enum Wearables {
  public static func configure() throws(MWDATCore.WearablesError)
  public static var shared: any MWDATCore.WearablesInterface { get }
}
```

URL callback — the CameraAccess sample filters on a query param before handing off:
```swift
.onOpenURL { url in
  guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
        c.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
  else { return }
  Task { _ = try await Wearables.shared.handleUrl(url) }   // throws(WearablesHandleURLError)
}
```

### Registration / pairing with the Meta AI app

```swift
var registrationState: RegistrationState { get }            // .unavailable/.available/.registering/.registered
func registrationStateStream() -> AsyncStream<RegistrationState>
func addRegistrationStateListener(_ listener: @escaping @Sendable (RegistrationState) -> Void) -> any AnyListenerToken
func startRegistration()   async throws(RegistrationError)   // opens Meta AI
func handleUrl(_ url: URL) async throws(WearablesHandleURLError) -> Bool
func startUnregistration() async throws(UnregistrationError)
func openFirmwareUpdate()        async throws(NavigationError)  // .metaAINotInstalled / .notRegistered
func openDATGlassesAppUpdate()   async throws(NavigationError)
```
`RegistrationError`: `.alreadyRegistered .configurationInvalid .metaAINotInstalled .networkUnavailable .timeout .unknown`.
Developer Mode (Meta AI app → Settings → your glasses → Developer Mode) + `MetaAppID = "0"` lets registration always succeed without Developer-Center provisioning. Registration needs internet.

## 3. Device discovery, DeviceSession, permissions

### `WearablesInterface` (the whole surface, verbatim)

```swift
public protocol WearablesInterface : Sendable {
  var registrationState: RegistrationState { get }
  func addRegistrationStateListener(_ listener: @escaping @Sendable (RegistrationState) -> Void) -> any AnyListenerToken
  func registrationStateStream() -> AsyncStream<RegistrationState>
  func startRegistration() async throws(RegistrationError)
  func handleUrl(_ url: URL) async throws(WearablesHandleURLError) -> Bool
  func startUnregistration() async throws(UnregistrationError)
  func openFirmwareUpdate() async throws(NavigationError)
  func openDATGlassesAppUpdate() async throws(NavigationError)
  var devices: [DeviceIdentifier] { get }                       // DeviceIdentifier == String
  func addDevicesListener(_ listener: @escaping @Sendable ([DeviceIdentifier]) -> Void) -> any AnyListenerToken
  func devicesStream() -> AsyncStream<[DeviceIdentifier]>
  func deviceForIdentifier(_ identifier: DeviceIdentifier) -> Device?
  func checkPermissionStatus(_ permission: Permission) async throws(PermissionError) -> PermissionStatus
  func requestPermission(_ permission: Permission) async throws(PermissionError) -> PermissionStatus
  func createSession(deviceSelector: any DeviceSelector) throws(DeviceSessionError) -> DeviceSession
  func deviceStateStream(for identifier: DeviceIdentifier) -> AsyncStream<DeviceState>
}
```

### `Device`
```swift
final public class Device : Sendable {
  final public let identifier: DeviceIdentifier
  final public var name: String { get }
  final public var deviceUUID: UUID { get }
  final public func nameOrId() -> String
  final public var linkState: LinkState { get }               // .disconnected/.connecting/.connected
  final public func addLinkStateListener(_ listener: @escaping @Sendable (LinkState) -> Void) -> any AnyListenerToken
  final public func addCompatibilityListener(_ listener: @escaping @Sendable (Compatibility) -> Void) -> any AnyListenerToken
  final public func deviceType() -> DeviceType
  final public func compatibility() -> Compatibility          // .undefined/.compatible/.deviceUpdateRequired/.sdkUpdateRequired
  final public func supportsDisplay() -> Bool
}

public enum DeviceType : String, CaseIterable, Sendable {
  case unknown, rayBanMeta, oakleyMetaHSTN, oakleyMetaVanguard,
       metaRayBanDisplay, rayBanMetaOptics, metaGlasses
}
extension DeviceType { public var supportsDisplay: Bool { get } }
```

### Selectors
```swift
public protocol DeviceSelector : Sendable {
  var activeDevice: DeviceIdentifier? { get }
  func activeDeviceStream() -> AnyAsyncSequence<DeviceIdentifier?>
}
public typealias DeviceFilter = @Sendable (Device) -> Bool

final public class AutoDeviceSelector : DeviceSelector {
  public init(wearables: any WearablesInterface, filter: DeviceFilter? = nil)
}
final public class SpecificDeviceSelector : DeviceSelector {
  public init(device: DeviceIdentifier)     // takes the IDENTIFIER, not the Device
}
```
For your app, pick the display-capable glasses: `AutoDeviceSelector(wearables: Wearables.shared, filter: { $0.supportsDisplay() })`.
Gotcha (from the display skill): `AutoDeviceSelector` populates from `devicesStream()`; create it *before* the user taps, or await a non-nil `activeDeviceStream()` value, otherwise `createSession` throws `DeviceSessionError.noEligibleDevice`.

### `DeviceSession`
```swift
final public class DeviceSession : Sendable {
  final public let deviceId: DeviceIdentifier
  final public var state: DeviceSessionState { get }
  final public var statePublisher: any Announcer<DeviceSessionState> { get }
  final public var errorPublisher: any Announcer<DeviceSessionError> { get }
  final public func start() throws(DeviceSessionError)
  final public func stop()
  final public func stateStream() -> AsyncStream<DeviceSessionState>
  final public func errorStream() -> AsyncStream<DeviceSessionError>
}

@frozen public enum DeviceSessionState : Equatable, Sendable {
  case idle, starting, started, paused, stopping, stopped
}

@frozen public enum DeviceSessionError : DatError, Equatable {
  case noEligibleDevice, sessionAlreadyStopped, sessionAlreadyExists, sessionIdle,
       capabilityAlreadyActive, capabilityNotFound,
       unexpectedError(description: String),
       thermalCritical, thermalEmergency, peakPowerShutdown, batteryCritical,
       datAppOnTheGlassesUpdateRequired, dwaUnavailable
}
```
0.9.0 behavior change: `stateStream()` / `errorStream()` **finish** once the session reaches `.stopped`; a stream created after stop finishes immediately. Don't reuse a stopped session — create a new one.

Capabilities requested on a started session (these are the only two "add" methods in 0.9.0):
```swift
// MWDATCamera
extension DeviceSession {
  final public func addCamera(config: StreamConfiguration = StreamConfiguration()) throws(DeviceSessionError) -> Camera?
}
// MWDATDisplay
extension DeviceSession {
  final public func addDisplay() throws(DeviceSessionError) -> Display
}
```
Note the asymmetry: `addCamera` returns an **Optional** `Camera?` (nil when the session isn't `.started`); `addDisplay` returns non-optional.

### Permissions
```swift
public enum Permission : Sendable, CaseIterable { case camera }     // camera is the ONLY permission
public enum PermissionStatus : Sendable { case granted, denied }
@objc public enum PermissionError : Int, DatError {
  case noDevice, noDeviceWithConnection, connectionError, metaAINotInstalled,
       requestInProgress, requestTimeout, internalError
}
let status = try await Wearables.shared.checkPermissionStatus(.camera)
let result = try await Wearables.shared.requestPermission(.camera)   // switches to Meta AI app and back
```
There is **no display permission** — display needs registration + a display-capable device only.

### Observation idioms
`Announcer<T>.listen { T in }` returns `any AnyListenerToken`; **dropping the token cancels the listener.** Use the 0.9.0 `ListenerTokenBag` actor:
```swift
public actor ListenerTokenBag {
  public init()
  nonisolated public func insert(_ token: (any AnyListenerToken)?)
  nonisolated public func clear()
  public func cancelAll() async
}
extension AnyListenerToken { public func store(in bag: ListenerTokenBag) }
```
Notification names also exist: `Notification.Name.mwdatDeviceSessionCreated`, `.mwdatStreamSessionCreated`, plus ObjC `NSNotification.wearablesRegistrationStateChanged` / `.wearablesDevicesChanged` / `.streamStateChanged` / `.streamFrameReceived` / `.streamPhotoCaptured` / `.streamErrorOccurred` / `.displayStateChanged`.

## 4. Camera streaming (MWDATCamera)

```swift
final public class Camera : Sendable {           // NEW in 0.9.0, replaces addStream()
  final public let stream: Stream
  final public var state: CameraState { get }    // .starting/.started/.stopping/.stopped
  final public var statePublisher: any Announcer<CameraState> { get }
  final public func stop()                       // cascades to stream, detaches from session
}

final public class Stream : Sendable {
  final public let streamConfiguration: StreamConfiguration
  final public var state: StreamState { get }
  final public var statePublisher:      any Announcer<StreamState> { get }
  final public var videoFramePublisher: any Announcer<VideoFrame> { get }
  final public var photoDataPublisher:  any Announcer<PhotoData> { get }
  final public var errorPublisher:      any Announcer<StreamError> { get }
  final public func start()                      // synchronous since 0.8.0
  final public func stop()
  @discardableResult final public func capturePhoto(format: PhotoCaptureFormat) -> Bool
}

public struct StreamConfiguration : Sendable {
  public let videoCodec: VideoCodec       // .raw | .hvc1
  public let resolution: StreamingResolution   // .high | .medium | .low
  public let frameRate: UInt
  public init(videoCodec: VideoCodec, resolution: StreamingResolution, frameRate: UInt)
  public init()                                 // defaults are UNVERIFIED (not in the interface)
}

public enum StreamingResolution : Sendable, CaseIterable {
  case high, medium, low
  public var videoFrameSize: VideoFrameSize { get }     // struct { let width: UInt; let height: UInt }
}

@frozen public enum StreamState : Sendable { case stopping, stopped, waitingForDevice, starting, streaming, paused }

public enum StreamError : DatError, Equatable {
  case internalError
  case deviceNotFound(DeviceIdentifier)
  case deviceNotConnected(DeviceIdentifier)
  case timeout, videoStreamingError, permissionDenied, hingesClosed,
       thermalCritical, thermalEmergency, peakPowerShutdown, batteryCritical,
       photoCaptureFailed
}
```

**Frame type — `CMSampleBuffer`:**
```swift
public struct VideoFrame : Sendable {
  public var sampleBuffer: CMSampleBuffer { get }
  public func makeUIImage() -> sending UIKit.UIImage?
}
```
No `CVPixelBuffer` accessor. With `.raw` you can pull the image buffer off the `CMSampleBuffer` yourself; with `.hvc1` the buffer is compressed HEVC and the sample app decodes it via its own `VideoFrameDecoder` before preview. **For "sample frames and run vision on them", use `videoCodec: .raw` and `frame.makeUIImage()` (or `CMSampleBufferGetImageBuffer`) — it avoids writing your own HEVC decoder.**

**Resolution / fps table** (from `camera-streaming/SKILL.md`; `videoFrameSize` returns these):

| `StreamingResolution` | size (W x H) |
|---|---|
| `.high`   | 720 x 1280 |
| `.medium` | 504 x 896 |
| `.low`    | 360 x 640 |

Valid frame rates: **2, 7, 15, 24, 30** FPS. Under Bluetooth bandwidth pressure the SDK degrades **resolution first**, then frame rate, **never below 15 FPS**. Lower requested settings give better per-frame quality (less compression).

**Start / stop, verbatim sample pattern:**
```swift
let session = try wearables.createSession(deviceSelector: selector)
try session.start()
for await state in session.stateStream() where state == .started { break }

guard try await wearables.checkPermissionStatus(.camera) == .granted ||
      (try await wearables.requestPermission(.camera)) == .granted else { return }

let config = StreamConfiguration(videoCodec: .raw, resolution: .medium, frameRate: 24)
guard let camera = try session.addCamera(config: config) else { return }   // nil if session not .started
let stream = camera.stream
stream.statePublisher.listen      { s in ... }.store(in: bag)   // subscribe BEFORE start()
stream.videoFramePublisher.listen { f in ... }.store(in: bag)
stream.photoDataPublisher.listen  { p in ... }.store(in: bag)
stream.errorPublisher.listen      { e in ... }.store(in: bag)
stream.start()
...
camera.stop()      // detach camera (cascades to stream); session stays up, addCamera() again to restart
session.stop()
```

## 5. Photo capture

```swift
public enum PhotoCaptureFormat : Sendable { case heic, jpeg }
public struct PhotoData : Sendable {
  public let data: Data
  public let format: PhotoCaptureFormat
  public init(data: Data, format: PhotoCaptureFormat)
}
@discardableResult func capturePhoto(format: PhotoCaptureFormat) -> Bool
```
- `capturePhoto` is **not** async and does **not** return the photo. The `Bool` only says the request was accepted. The photo arrives asynchronously on `stream.photoDataPublisher` as `PhotoData`.
- `data` is the **encoded full-resolution JPEG or HEIC** (Meta's own docs/CHANGELOG never state the pixel dimensions — the resolution number is **UNVERIFIED**, but it is explicitly a still capture independent of the stream resolution). `UIImage(data: photoData.data)` to decode.
- Failure surfaces as `StreamError.photoCaptureFailed` on the error publisher (0.9.0 removed the `CaptureError` enum).
- The stream must be running; capture while streaming is the documented flow.
- ObjC bridge exposes a `MWDATPhotoData.image: UIImage?` convenience; the **Swift** `PhotoData` has no `image` property — decode yourself.

## 6. Display (MWDATDisplay) — Meta Ray-Ban Display

### Capability object
```swift
final public class Display : Sendable {
  final public var state: DisplayState { get }              // .starting/.started/.stopping/.stopped
  final public var statePublisher: any Announcer<DisplayState> { get }
  final public var onPlaybackEvent: (@Sendable (VideoPlaybackEvent) -> Void)? { get set }
  final public func start()
  final public func stop()
  final public func send(_ view: some DisplayableView) async throws
  final public func clearDisplay() async throws
  final public func sendVideoStop() async
}
public enum DisplayError : DatError, Equatable {
  case deviceNotFound, connectionNotAvailable, deviceDisconnected,
       invalidVideoURL, displayError(String)
}
```
Note `send` / `clearDisplay` are **untyped** `throws` (not typed throws) — catch and downcast to `DisplayError`.

### Root views — only two types conform to `DisplayableView`
```swift
public protocol DisplayableView : Sendable {}
public protocol ViewComponent  : Sendable {}
extension FlexBox     : ViewComponent {}
extension FlexBox     : DisplayableView {}     // root for UI
extension Text        : ViewComponent {}
extension Image       : ViewComponent {}
extension Icon        : ViewComponent {}
extension Button      : ViewComponent {}
extension ButtonGroup : ViewComponent {}
public struct VideoPlayer : DisplayableView, Sendable { ... }   // root for video
```
**`Text`, `Image`, `Icon`, `Button`, `ButtonGroup` cannot be the root of a `send()` — wrap them in a `FlexBox`.**

### Components (all copied verbatim)
```swift
public struct FlexBox : Sendable {
  public var direction: Direction; public var children: [any ViewComponent]
  public var spacing: CGFloat; public var alignment: Alignment; public var crossAlignment: Alignment
  public var wrap: Bool; public var padding: EdgeInsets?; public var background: Background
  public var onClick: (@Sendable () -> Void)?
  public var flexGrow: Float; public var flexShrink: Float; public var alignSelf: Alignment?
  public init(direction: Direction = .column, spacing: CGFloat = 0,
              alignment: Alignment = .start, crossAlignment: Alignment = .start,
              wrap: Bool = false, padding: EdgeInsets? = nil,
              @ComponentBuilder content: () -> [any ViewComponent])
  public func flexGrow(_ value: Float) -> FlexBox
  public func flexShrink(_ value: Float) -> FlexBox
  public func alignSelf(_ value: Alignment) -> FlexBox
  public func padding(_ value: CGFloat) -> FlexBox
  public func padding(_ insets: EdgeInsets) -> FlexBox
  public func padding(_ edges: Edge, _ value: CGFloat) -> FlexBox
  public func background(_ value: Background) -> FlexBox
  public func onTap(_ handler: @escaping @Sendable () -> Void) -> FlexBox
}

public struct Text : Sendable {
  public let content: String; public let style: TextStyle; public let color: TextColor
  public init(_ content: String, style: TextStyle = .body, color: TextColor = .primary)
  public func flexGrow(_:) / flexShrink(_:) / alignSelf(_:) -> Text
}

public struct Image : Sendable {
  public let uri: String; public let sizePreset: ImageSize; public let cornerRadius: CornerRadius
  public init(uri: String, sizePreset: ImageSize = .icon, cornerRadius: CornerRadius = .none)
  public init(image: UIImage, sizePreset: ImageSize = .fill, cornerRadius: CornerRadius = .none)
  public func flexGrow(_:) / flexShrink(_:) / alignSelf(_:) -> Image
}

public struct Icon : Sendable {
  public let name: IconName; public let style: IconStyle
  public init(name: IconName, style: IconStyle = .filled)
}

public struct Button : Sendable {
  public let label: String; public let style: ButtonStyle
  public let iconName: IconName?; public let onClick: (@Sendable () -> Void)?
  public init(label: String, style: ButtonStyle = .primary, iconName: IconName? = nil,
              onClick: (@Sendable () -> Void)? = nil)
}

public struct ButtonGroup : Sendable {            // NEW in 0.9.0
  public init(alignment: ButtonGroupAlignment = .center,
              @ButtonGroupBuilder content: () -> [Button])
}

public struct VideoPlayer : DisplayableView, Sendable {
  public enum Provider : Sendable { case uri(String) }
  public let provider: Provider
  public let codec: VideoCodec                     // .unknown | .mp4
  public let onError: (@Sendable (VideoError) -> Void)?
  public init(provider: Provider, codec: VideoCodec = .mp4,
              onError: (@Sendable (VideoError) -> Void)? = nil)
}
```
Styling enums: `Direction {column,row,columnReverse,rowReverse}`, `Alignment {start,center,end,stretch}`,
`TextStyle {heading,body,meta}`, `TextColor {primary,secondary}`, `ButtonStyle {primary,secondary,outline}`,
`ButtonGroupAlignment {start,center,end}`, `ImageSize {icon,fill}`, `CornerRadius {none,small,medium}`,
`IconStyle {filled,outline}`, `Background {none,card}`,
`Edge : OptionSet {top,bottom,leading,trailing,horizontal,vertical,all}`,
`EdgeInsets(top:bottom:leading:trailing:)` / `EdgeInsets(all:)`.
`IconName` is a `String`-raw enum with **~120 cases** (`.checkmark .gear .arrowLeft .arrowRight .heart .house .clock .bell .star .metaAi .smartGlasses .videoCamera .x .plus …`). Use the enum — raw strings are not accepted by the Swift API.

Result builders: `@ComponentBuilder` (buildBlock / buildArray / buildOptional / buildEither first+second / buildExpression) → full if/else/for support inside `FlexBox { }`. `@ButtonGroupBuilder` likewise for `ButtonGroup { }`.

### Constraints (from `wearables.developer.meta.com/docs/develop/dat/display-overview` and `display-ios`)
- **Canvas: 600 x 600.** "The display resolution is 600x600" and "no benefit to sending larger images"; "oversized assets introduce lag due to Bluetooth bandwidth constraints."
- **"Each `send()` call replaces the entire display. There is no partial update mechanism, so always send the full layout."**
- **"Only one display capability can be attached to a session at a time."**
- **"Users must explicitly initiate a display session"**; your app has "exclusive display control during active sessions."
- "Views are presented one at a time with vertical scrolling. Horizontal scrolling is not supported."
- Display sleep: dims at 20s of inactivity, sleeps at 25s. **Sleep does not end the DAT session.**
- Video: "Keep videos under 400px per side and 70,000 total pixels." Non-HTTP(S)/blank URL → `DisplayError.invalidVideoURL`.
- Images should be HTTPS URLs (or a `UIImage` via the second `Image` init).
- Tap handlers (`FlexBox.onTap`, `Button.onClick`) belong to the **most recently sent** view; a new `send()` replaces them.
- Display acquires "medium then high" link leases (Wi-Fi fallback) — hence the `NSLocalNetworkUsageDescription` + `NSBonjourServices` keys.

### Correct attach order (from the DisplayAccess sample, `DisplayViewModel.swift`)
1. `AutoDeviceSelector(wearables:filter: { $0.supportsDisplay() })` — build it early.
2. `let session = try wearables.createSession(deviceSelector: selector)`
3. Subscribe to `session.stateStream()` and `session.errorStream()` **before** `try session.start()`.
4. On `.started` → `let display = try session.addDisplay()`.
5. Subscribe `display.statePublisher`, then `display.start()`.
6. On `DisplayState.started` → run the queued user action (`try await display.send(...)`).
7. Teardown: `display.onPlaybackEvent = nil; display.stop()` then `session.stop()`; drop tokens.
   Handle `DeviceSessionError.datAppOnTheGlassesUpdateRequired` separately → offer `Wearables.shared.openDATGlassesAppUpdate()`.

### Camera + Display on ONE session — the key open question
- Both `addCamera(config:)` and `addDisplay()` are extensions on the identical `MWDATCore.DeviceSession` class; the module split is packaging only.
- `DeviceSessionError.capabilityAlreadyActive` / `.capabilityNotFound` exist, and docs say "only one *display* capability" per session — phrasing that implies a per-capability-type limit, not one-capability-total.
- **However:** nothing in the 0.9.0 interface, CHANGELOG, skills, samples, or developer docs states that a camera and a display capability may be active simultaneously, and no sample does it (CameraAccess = camera only; DisplayAccess = display only). Whether the Meta Ray-Ban Display exposes camera streaming via DAT at all is also unstated. **Mark UNVERIFIED — prototype this first; it is the single riskiest assumption in the build.** Fallback if it fails: two sequential sessions, or attach display and drive photo capture through a separately created session.

## 7. Mock Device Kit (MWDATMockDevice)

```swift
public enum MockDeviceKit : Sendable { public static let shared: any MockDeviceKitInterface }

public protocol MockDeviceKitInterface : Sendable {
  var isEnabled: Bool { get }
  func enable(config: MockDeviceKitConfig)
  func disable()
  func pairGlasses(model: GlassesModel) throws(MockDeviceKitError) -> any MockGlasses
  func unpairDevice(_ device: any MockDevice)
  var pairedDevices: [any MockDevice] { get }
  var permissions: any MockPermissions { get }
  func startTestServer(portFilePath: String?) async throws -> UInt16
  func stopTestServer() async
}
extension MockDeviceKitInterface { public func enable() }        // convenience, default config

@frozen public struct MockDeviceKitConfig : Sendable {
  public let initiallyRegistered: Bool
  public let initialPermissionsGranted: Bool
  public init(initiallyRegistered: Bool = true, initialPermissionsGranted: Bool = true)
}

public enum GlassesModel : String, CaseIterable, Sendable {
  case rayBanMeta, oakleyMetaHSTN, oakleyMetaVanguard, rayBanMetaOptics, metaGlasses
}                                       // <-- NO metaRayBanDisplay case

public protocol MockDevice : Sendable {
  var deviceIdentifier: DeviceIdentifier { get }
  func powerOn(); func powerOff(); func don(); func doff()
}
public protocol MockGlasses : MockDevice {
  func fold(); func unfold()
  var services: any MockGlassesServices { get }
}
public protocol MockGlassesServices : Sendable {
  var camera: any MockCameraKit { get }
  var captouch: any MockCaptouchKit { get }
}                                       // <-- NO display service
public protocol MockCameraKit : Sendable {
  func setCameraFeed(fileURL: URL)
  func setCameraFeed(cameraFacing: CameraFacing)   // .front | .back — SYNCHRONOUS since 0.9.0
  func setCapturedImage(fileURL: URL)
}
public protocol MockCaptouchKit : Sendable { func tap(); func tapAndHold() }
public protocol MockPermissions : Sendable {
  func set(_ permission: Permission, _ status: PermissionStatus)
  func setRequestResult(_ permission: Permission, result: PermissionStatus)
}
public enum MockDeviceKitError : DatError, Equatable { case notEnabled }
```

**What it supports:** camera video feed (from a file URL or the phone's own camera), still-photo capture (`setCapturedImage`), captouch tap / tap-and-hold, device lifecycle (powerOn/Off, don/doff, fold/unfold), registration + permission simulation, and a localhost HTTP test server driven from a UI-test process via `MWDATMockDeviceTestClient`.

**What it does NOT support — Display.** Two independent pieces of evidence from the 0.9.0 interface: `GlassesModel` has no `metaRayBanDisplay` case, and `MockGlassesServices` exposes only `camera` and `captouch`. The developer docs' Mock Device Kit page never mentions display. **Plan on real Ray-Ban Display hardware for section 6.**

**Typical wiring (CameraAccess sample, `#if DEBUG` only):**
```swift
#if DEBUG
import MWDATMockDevice
MockDeviceKit.shared.enable()                                      // or .enable(config:)
let glasses = try MockDeviceKit.shared.pairGlasses(model: .rayBanMeta)
glasses.powerOn(); glasses.unfold(); glasses.don()
glasses.services.camera.setCameraFeed(fileURL: videoURL)           // h.265/HEVC only
glasses.services.camera.setCapturedImage(fileURL: imageURL)        // JPEG or PNG
MockDeviceKit.shared.permissions.set(.camera, .granted)
#endif
```
Media formats: **video must be h.265 (HEVC)**; images JPEG/PNG.
0.9.0 fix worth knowing: *"MockDeviceKit now uses the same Info.plist-based link-availability check as real devices. Apps missing Bluetooth/Wi-Fi Info.plist entitlements fail identically on mock and real hardware."* — i.e. you must add the Info.plist keys even to run against the mock.

`MWDATMockDeviceTestClient` (separate library, for the XCUITest process): `MockDeviceTestClient(port:)` / `()` / `(portFilePath:)` with `pairDevice(deviceType:)`, `powerOn/Off`, `don/doff`, `fold/unfold`, `captouchTap`, `captouchTapAndHold`, `setCameraFeed(deviceId:resourceName:ext:)`, `setCapturedImage(...)`, `getDeviceState()`, `healthCheck()`, `waitForServer(timeout:)`.

## 8. Gotchas

- **Concurrency:** built with `-swift-version 6`; all public types are `Sendable`. Publisher callbacks are `@Sendable` closures delivered on an **unspecified (non-main) thread** — the samples always hop with `Task { @MainActor in ... }`. The `dat-conventions` skill says explicitly: *"Never block the main thread with frame processing."* The CameraAccess sample decodes frames **off** the main actor and only publishes the finished `UIImage` to `@MainActor`.
- **Listener tokens are the lifetime.** Dropping an `AnyListenerToken` silently stops that listener. Use `ListenerTokenBag` (0.9.0) or hold the token in a property.
- **Sessions are not restartable.** `stateStream()`/`errorStream()` finish at `.stopped`; make a new `DeviceSession`.
- **Don't restart during `.paused`** — wait for `.started` or `.stopped`. The device, not the app, decides transitions, and `DeviceSessionState` never exposes the cause.
- **Hinges:** closing them drops Bluetooth and forces `.stopped`; reopening restores BT but does *not* restart sessions. `StreamError.hingesClosed` surfaces the doff case (fixed in 0.9.0).
- **Backgrounding:** the SDK supports background operation via `UIBackgroundModes` (`processing`, `bluetooth-central`, `bluetooth-peripheral`, plus `audio` for A/V recording). But CameraAccess deliberately **ends the preview session on background** in 0.9.0 rather than trying to preserve it, and suppresses the resulting teardown errors for ~5s. Treat background streaming as fragile.
- **No special entitlement** is needed beyond keychain-access-groups; the Wi-Fi/Hotspot entitlements are only for the Wi-Fi transport path.
- **Simulator:** supported (simulator slices ship), and MockDeviceKit is the intended simulator path. Real glasses obviously need a device.
- **`Text` / `Button` / `Image` name collisions with SwiftUI** in any file that imports both `SwiftUI` and `MWDATDisplay`. Either keep display builders in SwiftUI-free files or fully qualify: `MWDATDisplay.Text(...)`.
- **Meta AI app must be installed** and Developer Mode enabled per-device; Developer Mode toggles itself **off after firmware updates**. Symptoms of it being off: registration succeeds but the device never connects, or `StreamState` stuck in `.waitingForDevice`.
- **Thermals/battery** are first-class errors: `DeviceSessionError`/`StreamError` both carry `.thermalCritical .thermalEmergency .peakPowerShutdown .batteryCritical`. Monitor `Wearables.shared.deviceStateStream(for:)` → `DeviceState.thermalLevel` (`ThermalLevel {unknown,none,light,moderate,severe,critical,emergency,shutdown}`).
- **Compatibility gate:** `device.compatibility() == .deviceUpdateRequired` → `openFirmwareUpdate()`; `DeviceSessionError.datAppOnTheGlassesUpdateRequired` → `openDATGlassesAppUpdate()`.
- Known issue (repo skill doc): "[iOS] Meta Ray-Ban Display: no audio feedback on pause/resume."

## 9. Tag list and dates

| Tag | Date | Notes |
|---|---|---|
| **0.9.0** | **2026-08-03** | Consolidated `Camera` capability; `ButtonGroup`; `ListenerTokenBag`; min iOS **17.2**; `addStream` and `CaptureError` removed; DAM always on |
| 0.8.0 | 2026-06-25 | `DatError` unified errors; `clearDisplay()`; MockDeviceKit multi-model; Wi-Fi transport; `Stream.start()`/`Display.start()` became synchronous |
| 0.7.0 | 2026-05-14 | **Display capability introduced** (`MWDATDisplay`); DAM; captouch mocking; `MockDeviceTestClient`; `StreamSession*` → `Stream*` renames |
| 0.6.0 | 2026-04-15 | |
| 0.5.0 | 2026-03-11 | |
| 0.4.0 | 2026-02-04 | |
| 0.3.0 | 2025-12-16 | |
| 0.2.1 | 2025-12-04 | |

(No GitHub Releases objects exist — `/releases` is empty; dates above are from `CHANGELOG.md` and the tag listing.)

## Reference links
- API reference for 0.9: https://wearables.developer.meta.com/docs/reference/ios_swift/dat/0.9
- Developer docs: https://wearables.developer.meta.com/docs/develop/
- Static LLM context: https://wearables.developer.meta.com/llms.txt?full=true
- Live docs MCP (no auth): https://mcp.developer.meta.com/wearables (tool `search_dat_docs`)
- Samples: `samples/CameraAccess`, `samples/DisplayAccess` on `main`
