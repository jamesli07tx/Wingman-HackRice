// App.swift — SwiftUI lifecycle. Configures DAT at launch, routes the Meta AI registration
// callback URL, and shows the single StatusView (DESIGN.md §5.1 responsibility 4).
import SwiftUI
#if canImport(MWDATCore)
import MWDATCore
#endif

@main
struct WingmanApp: App {
  // NOT a default value: a stored property's initializer runs BEFORE this init's body, and BridgeController
  // must not be built until configure() has run and battery monitoring is on.
  @StateObject private var bridge: BridgeController

  init() {
    #if canImport(MWDATCore)
    DATSessionManager.configure()   // never traps; on failure BridgeController runs with dat == nil
    #endif
    UIDevice.current.isBatteryMonitoringEnabled = true
    _bridge = StateObject(wrappedValue: BridgeController())
  }

  var body: some Scene {
    WindowGroup {
      StatusView()
        .environmentObject(bridge)
        .onOpenURL { url in Task { await bridge.handleOpenURL(url) } }
    }
  }
}
