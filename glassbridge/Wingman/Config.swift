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
