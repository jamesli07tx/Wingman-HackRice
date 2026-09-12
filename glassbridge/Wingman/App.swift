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
