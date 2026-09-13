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

/// cortex/src/fairs/types.ts FairImport — only the fields the app shows.
struct FairImport: Decodable, Equatable {
  struct Company: Decodable, Equatable, Identifiable {
    let name: String
    let companyId: String?
    let status: String   // pending | matched | enriched | failed
    let note: String?
    var id: String { name }
  }
  let importId: String
  let fairName: String
  let source: String
  let sourceRef: String
  let status: String     // enriching | done | failed
  let companies: [Company]
  let done: Int
  let total: Int
  let reloaded: Bool
  let corpusSize: Int?
  let error: String?
  var finished: Bool { status != "enriching" }
}
struct FairImportEnvelope: Decodable { let `import`: FairImport }

/// C3 summary card (shared/src/schemas.ts): title ≤ 28, subtitle ≤ 48, 3–5 lines ≤ 40 each.
struct BriefCard: Codable, Equatable {
  var title: String
  var subtitle: String
  var lines: [String]
  static let titleMax = 28, subtitleMax = 48, lineMax = 40
}

/// One row of GET /api/me/companies: the shared card, or this user's own version when `custom`.
struct MyCompany: Decodable, Equatable, Identifiable {
  let companyId: String
  let name: String
  let card: BriefCard?
  let custom: Bool
  var id: String { companyId }
}

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

  // MARK: fair import (cortex/src/fairs/routes.ts — same Clerk bearer)

  func startFairImport(url: String, fairName: String?) async throws -> FairImport {
    var r = try await authorized(request("api/fairs/imports/link", "POST"))
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try JSONSerialization.data(withJSONObject: ["url": url, "fairName": fairName ?? ""].filter { !$0.value.isEmpty })
    let env: FairImportEnvelope = try decode(await send(r))
    return env.import
  }

  /// `fairName` goes BEFORE the file part — the route reads text fields that precede the file.
  func startFairImport(image: Data, filename: String, contentType: String, fairName: String?) async throws -> FairImport {
    var r = try await authorized(request("api/fairs/imports/image", "POST"))
    let boundary = "wingman-\(UUID().uuidString)"
    r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    var body = Data()
    if let fairName, !fairName.isEmpty {
      body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"fairName\"\r\n\r\n\(fairName)\r\n".utf8))
    }
    body.append(Self.multipart(boundary: boundary, name: "file", filename: filename, contentType: contentType, file: image))
    r.httpBody = body
    r.timeoutInterval = 90   // one opus extraction of the roster image happens before the 202
    let env: FairImportEnvelope = try decode(await send(r))
    return env.import
  }

  func fairImport(id: String) async throws -> FairImport {
    let env: FairImportEnvelope = try decode(await send(authorized(request("api/fairs/imports/\(id)", "GET"))))
    return env.import
  }

  func fairImports() async throws -> [FairImport] {
    struct Env: Decodable { let imports: [FairImport] }
    let env: Env = try decode(await send(authorized(request("api/fairs/imports", "GET"))))
    return env.imports
  }

  // MARK: my company briefs (cortex/src/rest/companyRoutes.ts)

  func myCompanies() async throws -> [MyCompany] {
    struct Env: Decodable { let companies: [MyCompany] }
    let env: Env = try decode(await send(authorized(request("api/me/companies", "GET"))))
    return env.companies
  }

  /// `companyId` nil = a company not on file (Cortex keys it by the name's slug).
  func saveCompanyCard(companyId: String?, name: String, card: BriefCard) async throws -> MyCompany {
    struct Body: Encodable { let name: String; let card: BriefCard }
    struct Env: Decodable { let company: MyCompany }
    var r = try await authorized(request(companyId.map { "api/me/companies/\($0)" } ?? "api/me/companies",
                                         companyId == nil ? "POST" : "PUT"))
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try Wire.encoder.encode(Body(name: name, card: card))
    let env: Env = try decode(await send(r))
    return env.company
  }

  func resetCompanyCard(companyId: String) async throws {
    _ = try await send(authorized(request("api/me/companies/\(companyId)", "DELETE")))
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
