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
