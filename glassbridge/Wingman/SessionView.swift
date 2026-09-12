// SessionView.swift — the running tab: one big Start/Stop, what the glasses last sent, and a replica of
// the card currently on the lens so you can judge the demo without borrowing someone's head. Debug
// tooling (spike, playground, DevHarness, manual code link, Cortex URL) hides at the bottom, Debug-only.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator — `armed` / `render` / `session_end`
// CONTRACT: DESIGN.md §4.2 HudCard (title + subtitle + ≤5 lines + footer) — the lens replica below
//   draws exactly those fields and nothing else, so what you see here is what the wearer sees.
// AT-INTEGRATION: Start from the phone, then from the dashboard; both must land on the same sessionId.
//
// INTEGRATION: SessionView
// IN:  bridge.armed / lastCard / lastFrame / framesSent / sessionId
// OUT: bridge.start / stop / runSpike / startTestFrames / applyCortexURL / link(code:)
// WIRE: RootView tab 3

import SwiftUI
import UIKit

@MainActor
struct SessionView: View {
  @EnvironmentObject private var bridge: BridgeController
  #if DEBUG
  @State private var manualCode = ""
  #endif

  var body: some View {
    VStack(spacing: 16) {
      controlCard
      if let card = bridge.lastCard { lensCard(card) }
      if let frame = bridge.lastFrame { frameCard(frame) }
      statsCard
      #if DEBUG
      debugTools
      #endif
    }
  }

  // MARK: start / stop

  private var controlCard: some View {
    Card {
      if bridge.armed {
        Button("Stop session") { bridge.stop() }
          .buttonStyle(PrimaryButtonStyle(color: Theme.danger))
      } else {
        Button("Start session") { bridge.start() }
          .buttonStyle(PrimaryButtonStyle())
          .disabled(!canStart)
        if let blocked = startBlockedBy { Banner(text: blocked) }
      }

      Toggle("Keep lens awake", isOn: $bridge.keepLensAwake)
        .font(.footnote)
        .foregroundStyle(Theme.muted)
        .tint(Theme.accent)

      if let hint = bridge.cortexHint { Banner(text: hint) }
      if let error = bridge.lastError, !error.hasPrefix("Glasses"), !error.hasPrefix("Registration") {
        Banner(text: error, kind: .error)
      }
    }
  }

  // MARK: what is on the lens right now

  private func lensCard(_ card: HudCard) -> some View {
    Card(title: "On the lens", symbol: "eye") {
      RoundedRectangle(cornerRadius: 14)
        .fill(Color.black)
        .aspectRatio(1, contentMode: .fit)     // the lens canvas is square (DESIGN.md §4.2 renderer contract)
        .overlay(alignment: .topLeading) {
          VStack(alignment: .leading, spacing: 6) {
            Text(card.title)
              .font(.system(.title3, design: .rounded).weight(.bold))
              .foregroundStyle(.white)
            if let subtitle = card.subtitle {
              Text(subtitle).font(.subheadline).foregroundStyle(Theme.accent)
            }
            ForEach(Array((card.lines ?? []).prefix(5).enumerated()), id: \.offset) { _, line in
              Text(line).font(.footnote).foregroundStyle(.white.opacity(0.85))
            }
            Spacer(minLength: 0)
            HStack {
              if let footer = card.footer { Text(footer) }
              Spacer()
              if let page = card.page { Text("\(page.index)/\(page.count)") }
            }
            .font(.caption2)
            .foregroundStyle(.white.opacity(0.5))
          }
          .padding(14)
        }
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.accent.opacity(0.30)))

      Text("\(card.kind.rawValue) · seq \(card.seq)").font(.caption2).foregroundStyle(Theme.muted)
    }
  }

  private func frameCard(_ frame: UIImage) -> some View {
    Card(title: "What the glasses see", symbol: "camera") {
      Image(uiImage: frame)
        .resizable()
        .scaledToFit()
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 12))
      Text("last frame sent to Cortex").font(.caption2).foregroundStyle(Theme.muted)
    }
  }

  private var statsCard: some View {
    Card {
      Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
        GridRow {
          Stat("Frames sent", "\(bridge.framesSent)")
          Stat("Battery", batteryText)
        }
        GridRow {
          Stat("Session", bridge.sessionId ?? "—")
          Stat("Cortex", "\(bridge.socketState)")
        }
      }
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
    if bridge.linkState == .unlinked { missing.append("link the glasses to your account") }
    #if canImport(MWDATCore)
    if let dat = bridge.dat, !dat.isConnected { missing.append("connect the glasses") }
    #endif
    return missing.isEmpty ? nil : "Needs: " + missing.joined(separator: " and ")
  }

  private var batteryText: String {
    let level = UIDevice.current.batteryLevel
    return level < 0 ? "—" : "\(Int(level * 100))%"
  }

  // MARK: Debug

  #if DEBUG
  private var debugTools: some View {
    Card {
      DisclosureGroup {
        VStack(alignment: .leading, spacing: 12) {
          Text("WS \(bridge.wsURL.absoluteString)").font(.caption2).foregroundStyle(Theme.muted)
            .lineLimit(1).truncationMode(.middle)

          // Integration day without a rebuild: paste the Fly host, tap Apply.
          HStack(spacing: 8) {
            TextField("", text: $bridge.cortexURLText,
                      prompt: Text("Cortex URL (host or wss://…)").foregroundColor(Theme.muted))
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .keyboardType(.URL)
              .font(.footnote)
              .wingmanField()
            Button("Apply") { bridge.applyCortexURL() }
              .font(.footnote.weight(.semibold))
              .foregroundStyle(Theme.accent)
          }

          // The fake Cortex. Never the path the demo falls into by default.
          Toggle("Use DevHarness", isOn: $bridge.useDevHarness)
            .font(.caption).foregroundStyle(Theme.muted).tint(Theme.accent)
          Text(Config.devHarnessWSURL.absoluteString).font(.caption2).foregroundStyle(Theme.muted)
            .lineLimit(1).truncationMode(.middle)

          // The pre-Clerk link path, kept for the harness (which mints no Clerk JWT) and for a dashboard code.
          Divider().overlay(Theme.hairline)
          if case let .linked(deviceId) = bridge.linkState {
            HStack {
              Pill("Linked · \(deviceId)", Theme.ok)
              Spacer()
              Button("Unlink", role: .destructive) { bridge.unlink() }.font(.caption)
            }
          } else {
            HStack(spacing: 8) {
              TextField("", text: $manualCode,
                        prompt: Text("6-digit code").foregroundColor(Theme.muted))
                .keyboardType(.numberPad)
                .font(.footnote.monospacedDigit())
                .wingmanField()
              Button("Link") { Task { await bridge.link(code: manualCode) } }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.accent)
                .disabled(manualCode.count != 6)
            }
          }

          Divider().overlay(Theme.hairline)
          Button("Run hour-zero spike (camera + display)") { Task { await bridge.runSpike() } }
            .font(.footnote).foregroundStyle(Theme.accent)
            .disabled(bridge.armed || bridge.spikeRunning)
          if let result = bridge.spikeResult {
            Text(result).font(.caption2).foregroundStyle(Theme.muted)
          }

          Button(bridge.testFramesRunning ? "Stop test frames" : "Send test frames (Simulator)") {
            bridge.startTestFrames()
          }
          .font(.footnote).foregroundStyle(Theme.accent)

          #if canImport(MWDATDisplay)
          // Flip real HudCards onto the lens with no Cortex and no session, to judge legibility.
          Divider().overlay(Theme.hairline)
          Text("Display playground").font(.footnote.weight(.semibold)).foregroundStyle(Theme.text)
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
          .font(.caption)
          HStack {
            Button("Sleep test (35 s)") { Task { await bridge.playgroundSleepTest() } }
            Button("Stop", role: .destructive) { Task { await bridge.playgroundStop() } }
          }
          .buttonStyle(.bordered)
          .font(.caption)
          if let status = bridge.playgroundStatus {
            Text(status).font(.caption2).foregroundStyle(Theme.muted)
          }
          #endif
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 10)
      } label: {
        Text("Debug tools").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
      }
      .tint(Theme.muted)
    }
  }
  #endif
}
