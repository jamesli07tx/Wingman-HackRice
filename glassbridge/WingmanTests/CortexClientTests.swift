import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

/// Records every request and answers from a canned script — no network, no Cortex, no Clerk.
final class StubURLProtocol: URLProtocol {
  struct Recorded {
    var method: String
    var path: String
    var headers: [String: String]
    var body: Data?
  }

  nonisolated(unsafe) static var responses: [(status: Int, body: String)] = []
  nonisolated(unsafe) static var recorded: [Recorded] = []

  static func reset(_ responses: [(status: Int, body: String)]) {
    self.responses = responses
    recorded = []
  }

  static func session() -> URLSession {
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: c)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    // URLSession has already turned httpBody into a stream by the time it reaches us.
    var body = request.httpBody
    if body == nil, let s = request.httpBodyStream {
      s.open()
      var data = Data()
      var buf = [UInt8](repeating: 0, count: 4096)
      while s.hasBytesAvailable {
        let n = s.read(&buf, maxLength: buf.count)
        if n <= 0 { break }
        data.append(buf, count: n)
      }
      s.close()
      body = data
    }
    Self.recorded.append(.init(method: request.httpMethod ?? "",
                               path: request.url?.path ?? "",
                               headers: request.allHTTPHeaderFields ?? [:],
                               body: body))

    let next = Self.responses.isEmpty ? (status: 200, body: "{}") : Self.responses.removeFirst()
    let resp = HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(next.body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

final class CortexClientTests: XCTestCase {
  private let base = URL(string: "https://cortex.test")!

  private func client() -> CortexClient {
    CortexClient(baseURL: base, tokenProvider: { "jwt-123" }, session: StubURLProtocol.session())
  }

  private func string(_ data: Data?) -> String { String(decoding: data ?? Data(), as: UTF8.self) }

  // MARK: multipart

  func testUploadResumeSendsOneMultipartPdfPart() async throws {
    StubURLProtocol.reset([(200, #"{"profile":{"name":"James Li","headline":"CS @ UT Austin"}}"#)])
    let pdf = Data("%PDF-1.7 fake".utf8)
    let profile = try await client().uploadResume(pdf: pdf)
    XCTAssertEqual(profile.name, "James Li")

    let r = try XCTUnwrap(StubURLProtocol.recorded.first)
    XCTAssertEqual(r.method, "POST")
    XCTAssertEqual(r.path, "/api/profile/resume")
    XCTAssertEqual(r.headers["Authorization"], "Bearer jwt-123")

    let contentType = try XCTUnwrap(r.headers["Content-Type"])
    let boundary = try XCTUnwrap(contentType.components(separatedBy: "boundary=").last)
    XCTAssertTrue(contentType.hasPrefix("multipart/form-data; boundary="), contentType)

    let body = string(r.body)
    XCTAssertTrue(body.hasPrefix("--\(boundary)\r\n"), body.prefix(80).description)
    XCTAssertTrue(body.contains("Content-Disposition: form-data; name=\"file\"; filename=\"resume.pdf\"\r\n"))
    XCTAssertTrue(body.contains("Content-Type: application/pdf\r\n\r\n"))
    XCTAssertTrue(body.contains("%PDF-1.7 fake"))
    XCTAssertTrue(body.hasSuffix("\r\n--\(boundary)--\r\n"), body.suffix(80).description)
    // Exactly one part: the boundary appears at the start and in the closing delimiter, nowhere else.
    XCTAssertEqual(body.components(separatedBy: "--\(boundary)").count - 1, 2)
  }

  // MARK: auth header

  func testAuthorizedCallsCarryBearerToken() async throws {
    StubURLProtocol.reset([(200, #"{"profile":null,"links":{"github":"https://github.com/x"}}"#),
                           (200, "[]")])
    let c = client()
    let env = try await c.getProfile()
    XCTAssertNil(env.profile)
    XCTAssertEqual(env.links?.github, "https://github.com/x")
    _ = try await c.devices()

    XCTAssertEqual(StubURLProtocol.recorded.map(\.path), ["/api/profile", "/api/devices"])
    for r in StubURLProtocol.recorded {
      XCTAssertEqual(r.headers["Authorization"], "Bearer jwt-123", r.path)
    }
  }

  // MARK: links

  func testSetLinksOmitsNilFields() async throws {
    StubURLProtocol.reset([(200, "{}")])
    try await client().setLinks(ProfileLinks(linkedin: "https://li/x", github: "https://gh/x"))

    let r = try XCTUnwrap(StubURLProtocol.recorded.first)
    XCTAssertEqual(r.method, "PUT")
    XCTAssertEqual(r.path, "/api/profile/links")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: r.body ?? Data()) as? [String: Any])
    XCTAssertEqual(Set(json.keys), ["linkedin", "github"])
  }

  func testHttpErrorCarriesStatusAndBody() async {
    StubURLProtocol.reset([(401, "unauthorized")])
    do {
      _ = try await client().getProfile()
      XCTFail("expected a 401")
    } catch let CortexError.http(status, body) {
      XCTAssertEqual(status, 401)
      XCTAssertEqual(body, "unauthorized")
    } catch {
      XCTFail("wrong error: \(error)")
    }
  }

  // MARK: link-code → claim

  func testLinkGlassesMintsACodeThenSpendsIt() async throws {
    StubURLProtocol.reset([(200, #"{"code":"483291","expiresAt":"2026-09-12T12:00:00Z"}"#),
                           (200, #"{"deviceId":"d_abc","deviceToken":"tok"}"#)])
    let claim = try await client().linkGlasses(name: "James's iPhone")
    XCTAssertEqual(claim, ClaimResponse(deviceId: "d_abc", deviceToken: "tok"))

    XCTAssertEqual(StubURLProtocol.recorded.map(\.path), ["/api/devices/link-code", "/api/devices/claim"])
    XCTAssertEqual(StubURLProtocol.recorded[0].headers["Authorization"], "Bearer jwt-123")
    // The claim is unauthenticated BY DESIGN — the code it just minted is the credential.
    XCTAssertNil(StubURLProtocol.recorded[1].headers["Authorization"])

    let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.recorded[1].body ?? Data()) as? [String: Any])
    XCTAssertEqual(sent["code"] as? String, "483291")
    XCTAssertEqual(sent["deviceType"] as? String, "glasses_bridge")
    XCTAssertEqual(sent["name"] as? String, "James's iPhone")
  }

  /// A failed link-code must not go on to claim anything.
  func testLinkGlassesStopsWhenTheCodeCallFails() async {
    StubURLProtocol.reset([(503, "db_unavailable")])
    do {
      _ = try await client().linkGlasses(name: "phone")
      XCTFail("expected a 503")
    } catch {
      XCTAssertEqual(StubURLProtocol.recorded.map(\.path), ["/api/devices/link-code"])
    }
  }

  // MARK: lenient decoding

  func testProfileSummaryDecodesPartialPayloads() throws {
    let json = #"""
    {"name":"James Li","headline":"CS @ UT Austin, class of 2027","skills":["TypeScript"],
     "experiences":[{"org":"Guadaloop","role":"Software lead","highlight":"telemetry"},{"org":"Solo"}],
     "interests":["fintech"],"links":{"github":"https://github.com/x"},"unknownField":42}
    """#
    let p = try Wire.decoder.decode(ProfileSummary.self, from: Data(json.utf8))
    XCTAssertEqual(p.skills, ["TypeScript"])
    XCTAssertEqual(p.experiences?.count, 2)
    XCTAssertNil(p.experiences?[1].role)
    XCTAssertEqual(p.links?.github, "https://github.com/x")
    XCTAssertTrue(ProfileLinks().isEmpty)
  }
}
