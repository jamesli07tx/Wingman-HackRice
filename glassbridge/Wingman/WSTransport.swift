// WSTransport.swift — one WebSocket connection on Network.framework, so the phone can be told WHICH interface
// to use. URLSession cannot: once the glasses' hotspot is joined (no internet on it) iOS routes new connections
// there until it notices, and every Cortex socket stalled or died. Here `.cellularFirst` requires cellular on
// even attempts and falls back to any interface on odd ones (Wi-Fi-only bench, simulator, no signal).
//
// INTEGRATION: WSTransport
// IN:  a ws/wss URL, a delivery queue, an interface policy, the attempt number (for the fallback cadence)
// OUT: onOpen / onText / onClose(Error?) on the delivery queue; send(text:) / ping() / cancel()
// WIRE: CortexSocket and DashboardSocket own one per connection attempt

import Foundation
import Network

final class WSTransport {
  enum Policy {
    /// Any interface — tests and the simulator.
    case any
    /// Cellular required on even attempts (0, 2, 4…), unrestricted on odd ones. The demo phone always has a
    /// dead-end Wi-Fi (the glasses' hotspot), so the common case never touches it.
    case cellularFirst
  }
  struct HandshakeTimeout: Error {}
  struct RemoteClose: Error {}

  var onOpen: (() -> Void)?
  var onText: ((String) -> Void)?
  var onClose: ((Error?) -> Void)?
  /// True when this attempt required cellular (diagnostic).
  let cellularOnly: Bool

  private let conn: NWConnection
  private let q: DispatchQueue
  private var closed = false
  private var opened = false

  init(url: URL, queue: DispatchQueue, policy: Policy, attempt: Int, connectTimeout: TimeInterval = 12) {
    q = queue
    let params: NWParameters = (url.scheme?.lowercased() == "wss") ? .tls : .tcp
    let ws = NWProtocolWebSocket.Options()
    ws.autoReplyPing = true
    params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    cellularOnly = (policy == .cellularFirst) && attempt % 2 == 0
    if cellularOnly { params.requiredInterfaceType = .cellular }
    conn = NWConnection(to: .url(url), using: params)
    conn.stateUpdateHandler = { [weak self] state in
      guard let self, !self.closed else { return }
      switch state {
      case .ready:
        self.opened = true
        self.onOpen?()
        self.receive()
      case .failed(let err):
        self.finish(err)
      case .cancelled:
        self.finish(nil)
      default:
        break   // .waiting (no cellular?) is covered by the handshake deadline below
      }
    }
    q.asyncAfter(deadline: .now() + connectTimeout) { [weak self] in
      guard let self, !self.opened, !self.closed else { return }
      self.finish(HandshakeTimeout())
    }
  }

  func start() { conn.start(queue: q) }

  func send(text: String, completion: @escaping (Error?) -> Void) {
    let meta = NWProtocolWebSocket.Metadata(opcode: .text)
    let ctx = NWConnection.ContentContext(identifier: "text", metadata: [meta])
    conn.send(content: Data(text.utf8), contentContext: ctx, isComplete: true,
              completion: .contentProcessed { err in completion(err) })
  }

  func ping(completion: @escaping (Error?) -> Void) {
    let meta = NWProtocolWebSocket.Metadata(opcode: .ping)
    let ctx = NWConnection.ContentContext(identifier: "ping", metadata: [meta])
    conn.send(content: Data("k".utf8), contentContext: ctx, isComplete: true,
              completion: .contentProcessed { err in completion(err) })
  }

  /// Silent teardown: no onClose. The owner is replacing or stopping us.
  func cancel() {
    closed = true
    conn.cancel()
  }

  private func receive() {
    conn.receiveMessage { [weak self] data, context, _, error in
      guard let self, !self.closed else { return }
      if let error { self.finish(error); return }
      let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
      switch meta?.opcode {
      case .text:
        if let data, let s = String(data: data, encoding: .utf8) { self.onText?(s) }
      case .close:
        self.finish(RemoteClose()); return
      default:
        break   // binary / pong / ping (auto-replied)
      }
      self.receive()
    }
  }

  private func finish(_ err: Error?) {
    guard !closed else { return }
    closed = true
    conn.cancel()
    onClose?(err)
  }
}
