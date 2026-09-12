// Config.swift — build-time configuration injected via Config.xcconfig → Info.plist (DESIGN_MAC.md §1.1),
// with a runtime override typed into StatusView so integration day needs no rebuild.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex fly.toml / deployed Cortex (Windows side provides the URLs)
// CONTRACT: DESIGN.md §4.1 base URL (https://…) and §4.2 device WebSocket (wss://…/ws/device?token=)
// AT-INTEGRATION: INTEGRATION-DAY: no rebuild needed — paste the Fly host into StatusView's "Cortex URL"
// field and tap Apply (it wins over Config.local.xcconfig); the xcconfig stays the build-time default.
//
// INTEGRATION: Config
// IN:  Info.plist keys CORTEX_URL, CORTEX_WS_URL, DEV_HARNESS_URL (strings, may be placeholders);
//      UserDefaults "cortexURLOverride" (whatever the operator pasted)
// OUT: URLs for LinkClient (REST base) and CortexSocket (WS); isCortexConfigured for the DevHarness default
// WIRE: BridgeController picks Config.cortexWSURL vs Config.devHarnessWSURL by its useDevHarness toggle

import Foundation

enum Config {
  static let placeholderHost = "REPLACE-ME"
  static let overrideKey = "cortexURLOverride"

  private static func string(_ key: String, default def: String) -> String {
    let v = Bundle.main.object(forInfoDictionaryKey: key) as? String
    return (v?.isEmpty == false) ? v! : def
  }

  /// Whatever the operator pasted into StatusView, verbatim. Empty string reads back as nil (= no override).
  static var cortexOverride: String? {
    get {
      let v = UserDefaults.standard.string(forKey: overrideKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
      return (v?.isEmpty == false) ? v : nil
    }
    set {
      let v = newValue?.trimmingCharacters(in: .whitespacesAndNewlines)
      if let v, !v.isEmpty { UserDefaults.standard.set(v, forKey: overrideKey) }
      else { UserDefaults.standard.removeObject(forKey: overrideKey) }
    }
  }

  /// Integration day hands over a URL in whatever shape the clipboard had it — bare host, https://, a trailing
  /// slash, or the full wss://…/ws/device. All four name the same deployment, so keep only the authority
  /// (host:port) and rebuild both URLs from it. http:// and ws:// stay insecure so a laptop Cortex still works.
  /// nil = not a host we can dial (empty, spaces, a bare word with no dot).
  static func normalizeOverride(_ raw: String) -> (rest: URL, ws: URL)? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    var secure = true
    if let r = s.range(of: "://") {
      let scheme = s[s.startIndex..<r.lowerBound].lowercased()
      guard ["http", "https", "ws", "wss"].contains(scheme) else { return nil }
      secure = (scheme == "https" || scheme == "wss")
      s = String(s[r.upperBound...])
    }
    let authority = s.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
    guard let rest = URL(string: "\(secure ? "https" : "http")://\(authority)"),
          let host = rest.host, host.contains(".") || host == "localhost",
          let ws = URL(string: "\(secure ? "wss" : "ws")://\(authority)/ws/device")
    else { return nil }
    return (rest, ws)
  }

  private static var override: (rest: URL, ws: URL)? { cortexOverride.flatMap(normalizeOverride) }

  /// REST base, e.g. https://wingman-cortex.fly.dev
  static var cortexURL: URL { override?.rest ?? URL(string: string("CORTEX_URL", default: "https://\(placeholderHost).fly.dev"))! }
  /// Device WebSocket, e.g. wss://wingman-cortex.fly.dev/ws/device (token appended by CortexSocket)
  static var cortexWSURL: URL { override?.ws ?? URL(string: string("CORTEX_WS_URL", default: "wss://\(placeholderHost).fly.dev/ws/device"))! }
  /// DevHarness WebSocket (glassbridge/DevHarness/harness.mjs)
  static var devHarnessWSURL: URL { URL(string: string("DEV_HARNESS_URL", default: "ws://localhost:8787/ws/device"))! }
  /// HTTP origin of the harness (it serves /api/devices/claim on the same port), derived from the WS URL.
  static var devHarnessHTTPURL: URL { httpOrigin(of: devHarnessWSURL) }
  /// False while Config.xcconfig still holds the REPLACE-ME placeholder, or while either URL is
  /// host-less → default to DevHarness. Host-less is the common xcconfig footgun: writing
  /// `CORTEX_WS_URL = wss://real.fly.dev/ws/device` without the `/$()/` trick makes xcconfig treat
  /// everything from `//` on as a comment, so the plist gets the bare string `wss:` — which
  /// `URL(string:)` happily accepts with a nil host. Dialing that silently fails; DevHarness is safer.
  static func isConfigured(_ url: URL) -> Bool {
    guard let host = url.host, !host.isEmpty else { return false }
    return !url.absoluteString.contains(placeholderHost)
  }

  /// A pasted override is a real deployment by construction, so this flips true the moment one is applied.
  static var isCortexConfigured: Bool { isConfigured(cortexWSURL) && isConfigured(cortexURL) }

  static func httpOrigin(of wsURL: URL) -> URL {
    var c = URLComponents(url: wsURL, resolvingAgainstBaseURL: false)!
    c.scheme = (c.scheme == "wss") ? "https" : "http"
    c.path = ""
    c.query = nil
    return c.url!
  }
}
