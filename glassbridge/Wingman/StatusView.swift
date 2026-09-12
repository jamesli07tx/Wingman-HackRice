// StatusView.swift — the ONE screen (DESIGN.md §5.1 responsibility 4), shaped as three numbered steps:
// 1 link to Cortex → 2 connect the glasses → 3 run a session. Each step is a card with a bold title, status
// pills and exactly one primary action, so the operator always knows which button is next. Debug tooling
// (spike, test frames, display playground) hides inside a collapsed disclosure group.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/rest/routes.ts POST /api/devices/claim (+ the console dashboard that shows the 6-digit code)
// CONTRACT: DESIGN.md §4.1 — { code, deviceType: "glasses_bridge", name } → { deviceId, deviceToken }
// AT-INTEGRATION: run once against live Cortex — type the dashboard code, tap Link; token lands in Keychain. Expect HTTP 404 (shown in the step-1 banner, recoverable: just retry) until the Windows side deploys.
//
// INTEGRATION: StatusView
// IN:  BridgeController published state via @EnvironmentObject
// OUT: link/unlink/connectGlasses/disconnectGlasses/start/stop/register/spike/test-frame actions on BridgeController
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
      ScrollView {
        VStack(spacing: 16) {
          linkStep
          glassesStep
          sessionStep
          #if DEBUG
          debugTools
          #endif
        }
        .padding()
      }
      .background(Color(.systemGroupedBackground))
      .navigationTitle("Wingman")
    }
  }

  // MARK: 1 · Link to Cortex

  private var linkStep: some View {
    stepCard(1, "Link to Cortex", "link") {
      switch bridge.linkState {
      case .unlinked:
        TextField("6-digit code from dashboard", text: $code)
          .keyboardType(.numberPad)
          .textFieldStyle(.roundedBorder)
          .font(.title3.monospacedDigit())
        Button("Link") { Task { await bridge.link(code: code) } }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .frame(maxWidth: .infinity)
          .disabled(code.count != 6)
      case let .linked(deviceId):
        HStack {
          pill("Linked · \(deviceId)", .green)
          Spacer()
          Button("Unlink", role: .destructive) { bridge.unlink() }.font(.footnote)
        }
      }

      HStack(spacing: 8) {
        pill("Cortex \(bridge.socketState)",
             bridge.socketState == .connected ? .green : bridge.socketState == .connecting ? .yellow : .red)
        Spacer()
        #if DEBUG
        Toggle("Use DevHarness", isOn: $bridge.useDevHarness).font(.caption).fixedSize()
        #endif
      }

      banner(.link)
    }
  }

  // MARK: 2 · Glasses

  private var glassesStep: some View {
    stepCard(2, "Glasses", "eyeglasses") {
      #if canImport(MWDATCore)
      if let dat = bridge.dat {
        // configure() worked — show what the hardware session has actually attached.
        // 2x2 rather than one row: four pills never fit across a phone.
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            pill(isRegistered(dat) ? "Registered" : "Not registered", isRegistered(dat) ? .green : .red)
            pill(dat.isConnected ? "Connected" : "Disconnected", dat.isConnected ? .green : .secondary)
          }
          HStack(spacing: 6) {
            pill("Display \(dat.displayState)", isDisplayStarted(dat) ? .green : .secondary)
            pill("Camera \(dat.streamState)", isStreaming(dat) ? .green : .secondary)
          }
          // The camera transport only works once the phone has joined the glasses' own hotspot.
          pill(dat.wifiSSID.map { "Hotspot: \($0)" } ?? "Hotspot: off", onGlassesHotspot(dat) ? .green : .secondary)
        }
        Text(dat.deviceName ?? "no device").font(.footnote).foregroundStyle(.secondary)

        if !isRegistered(dat) {
          primary("Register with Meta AI") { Task { await dat.register() } }
        } else if dat.isConnected {
          Button("Disconnect") { bridge.disconnectGlasses() }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
            .disabled(bridge.armed)
        } else {
          Button { Task { await bridge.connectGlasses() } } label: {
            HStack {
              if bridge.glassesConnecting { ProgressView().controlSize(.small) }
              Text(bridge.glassesConnecting ? "Connecting…" : "Connect glasses")
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .disabled(bridge.glassesConnecting)
        }
      } else {
        // configure() failed — the app still links, streams test frames and renders nothing. Not a crash.
        pill(DATSessionManager.configureError ?? "DAT unavailable", .red)
      }
      #else
      pill("DAT not linked into this build", .red)
      #endif

      banner(.glasses)
    }
  }

  // MARK: 3 · Session

  private var sessionStep: some View {
    stepCard(3, "Session", "play.circle") {
      if bridge.armed {
        Button("Stop", role: .destructive) { bridge.stop() }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .frame(maxWidth: .infinity)
      } else {
        primary("Start") { bridge.start() }
          .disabled(!canStart)
        if let missing = startBlockedBy {
          Text(missing).font(.caption).foregroundStyle(.secondary)
        }
      }

      Toggle("Keep lens awake", isOn: $bridge.keepLensAwake).font(.footnote)

      Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
        GridRow {
          stat("Frames sent", "\(bridge.framesSent)")
          stat("Battery", batteryText)
        }
        GridRow {
          stat("Session", bridge.sessionId ?? "—")
          stat("Last card", bridge.lastCard.map { "\($0.kind.rawValue) · \($0.title)" } ?? "—")
        }
      }

      banner(.session)
    }
  }

  private var canStart: Bool {
    guard case .linked = bridge.linkState, !bridge.spikeRunning else { return false }
    #if canImport(MWDATCore)
    if let dat = bridge.dat { return dat.isConnected }
    #endif
    return true          // no DAT on this build/phone: the Cortex half still runs (test frames)
  }

  /// One line under a disabled Start saying exactly which prerequisite is missing.
  private var startBlockedBy: String? {
    if canStart { return nil }
    if bridge.spikeRunning { return "Spike is running" }
    var missing: [String] = []
    if bridge.linkState == .unlinked { missing.append("link to Cortex (step 1)") }
    #if canImport(MWDATCore)
    if let dat = bridge.dat, !dat.isConnected { missing.append("connect the glasses (step 2)") }
    #endif
    return missing.isEmpty ? nil : "Needs: " + missing.joined(separator: " and ")
  }

  // MARK: Debug

  #if DEBUG
  private var debugTools: some View {
    DisclosureGroup("Debug tools") {
      VStack(alignment: .leading, spacing: 12) {
        Text("WS \(bridge.wsURL.absoluteString)").font(.caption2).foregroundStyle(.secondary)

        Button("Run hour-zero spike (camera + display)") { Task { await bridge.runSpike() } }
          .disabled(bridge.armed || bridge.spikeRunning)
        if let r = bridge.spikeResult { Text(r).font(.footnote).foregroundStyle(.secondary) }

        Button(bridge.testFramesRunning ? "Stop test frames" : "Send test frames (Simulator)") { bridge.startTestFrames() }

        #if canImport(MWDATDisplay)
        // Flip real HudCards onto the lens with no Cortex and no session, to judge legibility and pick a style.
        Divider()
        Text("Display playground").font(.subheadline.bold())
        Picker("Style", selection: $bridge.playgroundStyle) {
          ForEach(HudStyle.allCases, id: \.self) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        HStack {
          Button("◀ Prev") { Task { await bridge.playgroundShow(-1) } }
          Button("Next ▶") { Task { await bridge.playgroundShow(1) } }
          Button("Clear") { Task { await bridge.playgroundClear() } }
        }
        .buttonStyle(.bordered)            // else the whole row triggers every button
        HStack {
          Button("Sleep test (35 s)") { Task { await bridge.playgroundSleepTest() } }
          Button("Stop", role: .destructive) { Task { await bridge.playgroundStop() } }
        }
        .buttonStyle(.bordered)
        if let s = bridge.playgroundStatus { Text(s).font(.footnote).foregroundStyle(.secondary) }
        #endif
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 8)
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemGroupedBackground)))
  }
  #endif

  // MARK: building blocks

  private func stepCard<C: View>(_ number: Int, _ title: String, _ symbol: String,
                                 @ViewBuilder content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: symbol).foregroundStyle(.tint)
        Text("\(number) · \(title)").font(.headline)
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemGroupedBackground)))
  }

  private func pill(_ text: String, _ color: Color) -> some View {
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 8, height: 8)
      Text(text).font(.caption).lineLimit(1)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(Capsule().fill(Color(.tertiarySystemFill)))
  }

  private func primary(_ title: String, action: @escaping () -> Void) -> some View {
    Button(title, action: action)
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .frame(maxWidth: .infinity)
  }

  private func stat(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      Text(value).font(.footnote.monospacedDigit()).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// ponytail: one `lastError` string, routed to a step by its prefix — the producers all prefix consistently
  /// (LinkClient "Claim failed: …", BridgeController "Glasses: …", DATSessionManager "Registration failed: …").
  private enum Step { case link, glasses, session }

  private static func step(for error: String) -> Step {
    if error.hasPrefix("Claim") { return .link }
    if error.hasPrefix("Glasses") || error.hasPrefix("Registration") || error.hasPrefix("DAT") { return .glasses }
    return .session
  }

  @ViewBuilder private func banner(_ step: Step) -> some View {
    if let e = bridge.lastError, Self.step(for: e) == step {
      Text(e)
        .font(.footnote)
        .foregroundStyle(.red)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.red.opacity(0.12)))
    }
  }

  // `if case` rather than `==`: only DeviceSessionState is documented Equatable (docs/dat-0.9.0-api-notes.md §3),
  // and pattern matching works whatever the DAT enums' payloads turn out to be.
  #if canImport(MWDATCore)
  private func isStreaming(_ dat: DATSessionManager) -> Bool { if case .streaming = dat.streamState { return true }; return false }
  private func isDisplayStarted(_ dat: DATSessionManager) -> Bool { if case .started = dat.displayState { return true }; return false }
  private func isRegistered(_ dat: DATSessionManager) -> Bool { if case .registered = dat.registration { return true }; return false }
  /// The glasses' hotspot announces itself as "Meta RB Display …" — any other SSID means the join has not happened.
  private func onGlassesHotspot(_ dat: DATSessionManager) -> Bool {
    guard let ssid = dat.wifiSSID else { return false }
    return ["Meta", "Display"].contains { ssid.range(of: $0, options: .caseInsensitive) != nil }
  }
  #endif

  private var batteryText: String {
    let b = UIDevice.current.batteryLevel
    return b < 0 ? "—" : "\(Int(b * 100))%"
  }
}
