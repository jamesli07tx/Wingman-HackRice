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
