// CortexClient.swift — the account-side REST surface (DESIGN.md §4.1), everything GlassBridge needs
// once the user is signed in with Clerk: upload the resume, save the links, read the profile back, and
// link these glasses without anyone typing a 6-digit code.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/rest/routes.ts — /api/profile{,/resume,/links}, /api/devices{,/link-code,/claim}
// CONTRACT: DESIGN.md §4.1. Clerk JWT in `Authorization: Bearer` on everything EXCEPT /api/devices/claim,
//   whose credential is the one-time link code (that asymmetry is D9, not an oversight).
// AT-INTEGRATION: sign in on the phone, drop a PDF in, watch Cortex log the parse; then confirm the
//   auto-linked device shows up in GET /api/devices with deviceType "glasses_bridge".
//
// INTEGRATION: CortexClient
// IN:  baseURL (Config.cortexURL) + tokenProvider (AuthManager.token — a fresh Clerk JWT per call)
// OUT: ProfileEnvelope / ProfileSummary / ClaimResponse / [DeviceInfo], or CortexError
// WIRE: BridgeController.refreshProfile / uploadResume / saveLinks / linkGlassesViaAccount

import Foundation

enum CortexError: Error, LocalizedError {
  case http(Int, String)
  case transport(Error)

  var errorDescription: String? {
    switch self {
    case let .http(status, body):
      let hint = status == 401 ? " — sign in again" : (status == 404 ? " — Cortex not deployed / route missing?" : "")
      return "Cortex: HTTP \(status)\(hint) \(body)"
    case let .transport(e): return "Cortex: \(e.localizedDescription)"
    }
  }
}

struct CortexClient {
  let baseURL: URL
  /// Called immediately before every authenticated request — Clerk's own cache is the right layer
  /// to hold the JWT (1-minute TTL), so never stash the string here.
  let tokenProvider: () async throws -> String
  var session: URLSession = .shared

  // MARK: profile

  func getProfile() async throws -> ProfileEnvelope {
    try decode(await send(authorized(request("api/profile", "GET"))))
  }

  /// One multipart part, hand-rolled: the route takes the first file whatever its field name is.
  func uploadResume(pdf: Data) async throws -> ProfileSummary {
    var r = try await authorized(request("api/profile/resume", "POST"))
    let boundary = "wingman-\(UUID().uuidString)"
    r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    r.httpBody = Self.multipart(boundary: boundary, name: "file", filename: "resume.pdf",
                                contentType: "application/pdf", file: pdf)
    let env: ProfileEnvelope = try decode(await send(r))
    guard let profile = env.profile else { throw CortexError.http(200, "no profile in response") }
    return profile
  }

  func setLinks(_ links: ProfileLinks) async throws {
    var r = try await authorized(request("api/profile/links", "PUT"))
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try Wire.encoder.encode(links)   // nil fields are omitted, never sent as null
    _ = try await send(r)
  }

  // MARK: devices

  /// The whole point of signing in: mint a link code as the user, then spend it as the device.
  /// Two calls, in that order — the claim is deliberately unauthenticated (DESIGN.md §4.1, D9).
  func linkGlasses(name: String) async throws -> ClaimResponse {
    let code: LinkCodeResponse = try decode(await send(authorized(request("api/devices/link-code", "POST"))))
    return try await LinkClient.claim(baseURL: baseURL, code: code.code, name: name, session: session)
  }

  func devices() async throws -> [DeviceInfo] {
    try decode(await send(authorized(request("api/devices", "GET"))))
  }

  // MARK: plumbing

  static func multipart(boundary: String, name: String, filename: String,
                        contentType: String, file: Data) -> Data {
    var body = Data("--\(boundary)\r\n".utf8)
    body.append(Data("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n".utf8))
    body.append(Data("Content-Type: \(contentType)\r\n\r\n".utf8))
    body.append(file)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    return body
  }

  private func request(_ path: String, _ method: String) -> URLRequest {
    var r = URLRequest(url: baseURL.appendingPathComponent(path))
    r.httpMethod = method
    r.timeoutInterval = 30          // resume parsing is an LLM round-trip, not a ping
    return r
  }

  private func authorized(_ request: URLRequest) async throws -> URLRequest {
    var r = request
    r.setValue("Bearer \(try await tokenProvider())", forHTTPHeaderField: "Authorization")
    return r
  }

  @discardableResult
  private func send(_ request: URLRequest) async throws -> Data {
    let data: Data, resp: URLResponse
    do { (data, resp) = try await session.data(for: request) } catch { throw CortexError.transport(error) }
    let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw CortexError.http(status, String(decoding: data.prefix(200), as: UTF8.self))
    }
    return data
  }

  private func decode<T: Decodable>(_ data: Data) throws -> T {
    try Wire.decoder.decode(T.self, from: data)
  }
}
