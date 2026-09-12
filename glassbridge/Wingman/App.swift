// App.swift — SwiftUI lifecycle. Configures DAT and Clerk at launch, routes the Meta AI registration
// callback URL, and shows RootView (DESIGN.md §5.1 responsibility 4).
import SwiftUI
import ClerkKit
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
    // Synchronous and once-only (research §2). Guarded: an empty key would trip Clerk's own
    // assertionFailure, and a build with no key should simply have no sign-in, not crash.
    if AuthManager.isAvailable { Clerk.configure(publishableKey: Config.clerkPublishableKey) }
    UIDevice.current.isBatteryMonitoringEnabled = true
    _bridge = StateObject(wrappedValue: BridgeController())
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(bridge)
        .modifier(ClerkEnvironment())   // what ClerkKitUI's AuthView reads; skipped when there is no key
        .onOpenURL { url in Task { await bridge.handleOpenURL(url) } }
    }
  }
}
