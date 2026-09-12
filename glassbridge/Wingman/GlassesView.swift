// GlassesView.swift — the hardware tab, lifted out of the old StatusView step 2 with the same pills and
// the same two buttons (Connect / Force reconnect). Nothing about the DAT behaviour changed.
//
// INTEGRATION: GlassesView
// IN:  bridge.dat state (registration / session / display / stream / hotspot), bridge.reconnectStatus
// OUT: bridge.connectGlasses / disconnectGlasses / userForceReconnect / linkGlassesViaAccount
// WIRE: RootView tab 2

import SwiftUI
#if canImport(MWDATCore)
import MWDATCore   // DAT state enums for `if case` patterns only; MWDATDisplay stays out of this file
#endif

@MainActor
struct GlassesView: View {
  @EnvironmentObject private var bridge: BridgeController

  var body: some View {
    VStack(spacing: 16) {
      if case .unlinked = bridge.linkState { linkCard }
      hardwareCard
    }
  }

  /// Only shows when the automatic link after sign-in did not take (offline, Cortex down, 401).
  private var linkCard: some View {
    Card(title: "Link these glasses", symbol: "person.badge.key") {
      Text("Wingman links the glasses to your account by itself right after sign-in. Tap if that didn't take.")
        .font(.footnote).foregroundStyle(Theme.muted)
        .fixedSize(horizontal: false, vertical: true)
      Button {
        Task { await bridge.linkGlassesViaAccount() }
      } label: {
        HStack(spacing: 8) {
          if bridge.profileBusy { ProgressView().controlSize(.small).tint(.black) }
          Text("Link now")
        }
      }
      .buttonStyle(PrimaryButtonStyle())
      .disabled(bridge.profileBusy || !bridge.accountReady)
    }
  }

  private var hardwareCard: some View {
    Card(title: "Glasses", symbol: "eyeglasses") {
      #if canImport(MWDATCore)
      if let dat = bridge.dat {
        // 2×2 rather than one row: four pills never fit across a phone.
        HStack(spacing: 6) {
          Pill(isRegistered(dat) ? "Registered" : "Not registered", isRegistered(dat) ? Theme.ok : Theme.danger)
          Pill(dat.isConnected ? "Connected" : "Disconnected", dat.isConnected ? Theme.ok : Theme.muted)
        }
        HStack(spacing: 6) {
          Pill("Display \(dat.displayState)", isDisplayStarted(dat) ? Theme.ok : Theme.muted)
          Pill("Camera \(dat.streamState)", bridge.cameraReady ? Theme.ok : Theme.muted)
        }
        // The camera transport only works once the phone has joined the glasses' own hotspot.
        Pill(dat.wifiSSID.map { "Hotspot: \($0)" } ?? "Hotspot: off", onGlassesHotspot(dat) ? Theme.ok : Theme.muted)

        Text(dat.deviceName ?? "no device").font(.footnote).foregroundStyle(Theme.muted)
        Text("Camera streams while connected; Start only begins sending to Cortex.")
          .font(.caption).foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)

        if !isRegistered(dat) {
          Button("Register with Meta AI") { Task { await dat.register() } }
            .buttonStyle(PrimaryButtonStyle())
        } else if dat.isConnected {
          Button("Disconnect") { bridge.disconnectGlasses() }
            .buttonStyle(GhostButtonStyle())
            .disabled(bridge.armed)
        } else {
          Button {
            Task { await bridge.connectGlasses() }
          } label: {
            HStack(spacing: 8) {
              if bridge.glassesConnecting { ProgressView().controlSize(.small).tint(.black) }
              Text(bridge.glassesConnecting ? "Connecting…" : "Connect glasses")
            }
          }
          .buttonStyle(PrimaryButtonStyle())
          .disabled(bridge.glassesConnecting)
        }

        // The hotspot join can leave iOS in a state where every Connect fails until the entry is
        // dropped — this is the button that drops it. Automatic recovery uses the same path.
        Button("Force reconnect") { Task { await bridge.userForceReconnect() } }
          .buttonStyle(GhostButtonStyle())
          .disabled(bridge.glassesConnecting || bridge.reconnecting)

        if let status = bridge.reconnectStatus { Banner(text: status, kind: .warning) }
      } else {
        // configure() failed — the app still links, streams test frames and renders nothing. Not a crash.
        Pill(DATSessionManager.configureError ?? "DAT unavailable", Theme.danger)
        Text("No glasses on this build: the Simulator has no DAT session. Everything else still works.")
          .font(.caption).foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
      #else
      Pill("DAT not linked into this build", Theme.danger)
      #endif

      if let error = bridge.lastError, error.hasPrefix("Glasses") || error.hasPrefix("Registration") {
        Banner(text: error, kind: .error)
      }
    }
  }

  // `if case` rather than `==`: only DeviceSessionState is documented Equatable (docs/dat-0.9.0-api-notes.md §3).
  #if canImport(MWDATCore)
  private func isDisplayStarted(_ dat: DATSessionManager) -> Bool { if case .started = dat.displayState { return true }; return false }
  private func isRegistered(_ dat: DATSessionManager) -> Bool { if case .registered = dat.registration { return true }; return false }
  private func onGlassesHotspot(_ dat: DATSessionManager) -> Bool {
    dat.wifiSSID.map(DATSessionManager.isGlassesSSID) ?? false
  }
  #endif
}
