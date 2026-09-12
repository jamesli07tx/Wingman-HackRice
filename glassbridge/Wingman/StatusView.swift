// StatusView.swift — the ONE screen (DESIGN.md §5.1 responsibility 4): link state, connection dots, Start/Stop,
// battery, last error. Nothing else — plus Debug-only rows for the DevHarness toggle, the spike and test frames.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/rest/routes.ts POST /api/devices/claim (+ the console dashboard that shows the 6-digit code)
// CONTRACT: DESIGN.md §4.1 — { code, deviceType: "glasses_bridge", name } → { deviceId, deviceToken }
// AT-INTEGRATION: run once against live Cortex — type the dashboard code, tap Link; token lands in Keychain. Expect HTTP 404 (shown in "Last error", recoverable: just retry) until the Windows side deploys.
//
// INTEGRATION: StatusView
// IN:  BridgeController published state via @EnvironmentObject
// OUT: link/unlink/start/stop/register/spike/test-frame actions on BridgeController
// WIRE: App.swift → StatusView().environmentObject(bridge)

import SwiftUI
import UIKit
#if canImport(MWDATCore)
import MWDATCore   // only for DAT state enums in `if case` patterns; MWDATDisplay (Text/Image) stays out of this file
#endif

@MainActor
struct StatusView: View {
  @EnvironmentObject private var bridge: BridgeController
  @State private var code = ""

  var body: some View {
    NavigationStack {
      Form {
        Section("Link") {
          switch bridge.linkState {
          case .unlinked:
            TextField("6-digit code from dashboard", text: $code).keyboardType(.numberPad)
            Button("Link") { Task { await bridge.link(code: code) } }.disabled(code.count != 6)
          case let .linked(deviceId):
            LabeledContent("Device", value: deviceId)
            Button("Unlink", role: .destructive) { bridge.unlink() }
          }
        }

        Section("Connections") {
          dot("Cortex",
              state: bridge.socketState == .connected ? .green : bridge.socketState == .connecting ? .yellow : .red,
              text: "\(bridge.socketState)" + (bridge.useDevHarness ? " (DevHarness)" : ""))
          #if canImport(MWDATCore)
          if let dat = bridge.dat {
            dot("Glasses", state: sessionColor(dat),
                text: "\(dat.registration) · \(dat.deviceName ?? "no device") · session \(dat.sessionState)")
            dot("Stream", state: isStreaming(dat) ? .green : .gray, text: "\(dat.streamState)")
            dot("Display", state: isDisplayStarted(dat) ? .green : .gray, text: "\(dat.displayState)")
            if !isRegistered(dat) {
              Button("Register with Meta AI") { Task { await dat.register() } }
            }
          } else {
            // configure() failed — the app still links, streams test frames and renders nothing. Not a crash.
            dot("Glasses", state: .red,
                text: "DAT unavailable: \(DATSessionManager.configureError ?? "not configured")")
          }
          #endif
        }

        Section("Session") {
          if bridge.armed {
            Button("Stop", role: .destructive) { bridge.stop() }
            LabeledContent("Session", value: bridge.sessionId ?? "-")
          } else {
            Button("Start") { bridge.start() }.disabled(bridge.linkState == .unlinked || bridge.spikeRunning)
          }
          LabeledContent("Frames sent", value: "\(bridge.framesSent)")
          LabeledContent("Battery", value: batteryText)
          if let card = bridge.lastCard {
            LabeledContent("Last card", value: "\(card.kind.rawValue) · \(card.title) (#\(card.seq))")
          }
        }

        if let err = bridge.lastError {
          Section("Last error") { Text(err).foregroundStyle(.red).font(.footnote) }
        }

        #if DEBUG
        Section("Debug") {
          Toggle("Use DevHarness", isOn: $bridge.useDevHarness)
          LabeledContent("WS", value: bridge.wsURL.absoluteString).font(.footnote)
          Button("Run hour-zero spike (camera + display)") { Task { await bridge.runSpike() } }.disabled(bridge.armed || bridge.spikeRunning)
          if let r = bridge.spikeResult { Text(r).font(.footnote) }
          Button(bridge.testFramesRunning ? "Stop test frames" : "Send test frames (Simulator)") { bridge.startTestFrames() }
        }
        #endif
      }
      .navigationTitle("Wingman")
    }
  }

  // `if case` rather than `==`: only DeviceSessionState is documented Equatable (docs/dat-0.9.0-api-notes.md §3),
  // and pattern matching works whatever the DAT enums' payloads turn out to be.
  #if canImport(MWDATCore)
  private func sessionColor(_ dat: DATSessionManager) -> Color {
    if case .started = dat.sessionState { return .green }
    if case .starting = dat.sessionState { return .yellow }
    return .gray
  }
  private func isStreaming(_ dat: DATSessionManager) -> Bool { if case .streaming = dat.streamState { return true }; return false }
  private func isDisplayStarted(_ dat: DATSessionManager) -> Bool { if case .started = dat.displayState { return true }; return false }
  private func isRegistered(_ dat: DATSessionManager) -> Bool { if case .registered = dat.registration { return true }; return false }
  #endif

  private var batteryText: String {
    let b = UIDevice.current.batteryLevel
    return b < 0 ? "-" : "\(Int(b * 100))%"
  }

  private func dot(_ label: String, state: Color, text: String) -> some View {
    HStack {
      Circle().fill(state).frame(width: 10, height: 10)
      Text(label)
      Spacer()
      Text(text).foregroundStyle(.secondary).font(.footnote).lineLimit(1)
    }
  }
}
