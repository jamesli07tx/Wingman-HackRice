// FeedView.swift — the observability window (DESIGN.md §4.3), on the wearer's own phone: per sent frame,
// what Cortex's models made of it. This is the console's /feed, for the person wearing the glasses —
// the answer to "is recognition actually working, or am I filming a wall?"
//
// INTEGRATION: FeedView
// IN:  bridge.feed / gateStats / lastGate / dashboardState / gateSilent / armed / framesSent
// OUT: bridge.clearFeed()
// WIRE: RootView tab 4

import SwiftUI
import UIKit

@MainActor
struct FeedView: View {
  @EnvironmentObject private var bridge: BridgeController

  var body: some View {
    VStack(spacing: 16) {
      counters
      rows
    }
  }

  // MARK: live counters + diagnosis

  private var counters: some View {
    Card(title: "Live telemetry", symbol: "waveform.path.ecg") {
      HStack {
        Pill(dashboardLabel, dashboardColor)
        Spacer()
        Button("Clear") { bridge.clearFeed() }
          .font(.footnote.weight(.semibold))
          .foregroundStyle(Theme.accent)
          .disabled(bridge.feed.isEmpty)
      }

      Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
        GridRow {
          Stat("Frames sent", "\(bridge.gateStats.frames)")
          Stat("Gate results", "\(bridge.gateStats.gated)")
          Stat("Last gate", lastGateText)
        }
        GridRow {
          Stat("banner", "\(bridge.gateStats.banner)")
          Stat("document", "\(bridge.gateStats.document)")
          Stat("nothing", "\(bridge.gateStats.nothing)")
        }
      }

      if bridge.dashboardState != .connected {
        Banner(text: "Dashboard socket \(bridge.dashboardState) — no telemetry is arriving. It needs a signed-in session and a real Cortex URL.",
               kind: .warning)
      } else if bridge.gateSilent {
        Banner(text: "Cortex is receiving frames but publishing no gate results — check the session is armed on Cortex (/feed on the console) or the dashboard socket (\(bridge.dashboardState)).",
               kind: .warning)
      }
    }
  }

  private var lastGateText: String {
    guard let last = bridge.lastGate else { return "—" }
    return [last.gateClass?.rawValue ?? "unknown", last.orgHint].compactMap { $0 }.joined(separator: " · ")
  }

  private var dashboardLabel: String { "dashboard · \(bridge.dashboardState)" }

  private var dashboardColor: Color {
    switch bridge.dashboardState {
    case .connected: return Theme.ok
    case .connecting: return Theme.warn
    case .disconnected: return Theme.danger
    }
  }

  // MARK: the timeline
  //
  // ponytail: a LazyVStack, not a List — this tab is already inside RootView's ScrollView, and a List
  // nested in a ScrollView collapses to a fixed-height scroller. Capped at 200 rows in BridgeController.

  private var rows: some View {
    Card {
      if bridge.feed.isEmpty {
        Text("No telemetry yet. Press Start on the Session tab; every frame you send will show up here with Cortex's verdict.")
          .font(.footnote)
          .foregroundStyle(Theme.muted)
      } else {
        LazyVStack(spacing: 0) {
          ForEach(bridge.feed) { item in
            row(item)
            if item.id != bridge.feed.last?.id { Divider().overlay(Theme.hairline) }
          }
        }
      }
    }
  }

  private func row(_ item: FeedItem) -> some View {
    HStack(alignment: .top, spacing: 12) {
      thumbnail(item)
      VStack(alignment: .leading, spacing: 4) {
        Text(item.title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(color(item.tint))
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
          .background(Capsule().fill(color(item.tint).opacity(0.14)))
        if let sub = subtitle(item) {
          Text(sub).font(.caption2).foregroundStyle(Theme.muted).lineLimit(2)
        }
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 2) {
        Text(clock(item.time)).font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted)
        // Gate rows carry the round trip: frame sent → Cortex's verdict.
        if item.kind == .gate, let latency = item.detail {
          Text(latency).font(.caption2.monospacedDigit()).foregroundStyle(Theme.accent)
        }
      }
    }
    .padding(.vertical, 8)
  }

  /// The frame Cortex judged, when we still hold it; otherwise a glyph for the row's kind.
  @ViewBuilder
  private func thumbnail(_ item: FeedItem) -> some View {
    if let image = item.thumbnail {
      Image(uiImage: image)
        .resizable()
        .scaledToFill()
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    } else {
      RoundedRectangle(cornerRadius: 10)
        .fill(Theme.field)
        .frame(width: 56, height: 56)
        .overlay(Image(systemName: glyph(item.kind)).foregroundStyle(color(item.tint).opacity(0.8)))
    }
  }

  private func subtitle(_ item: FeedItem) -> String? {
    if item.kind == .gate { return item.frameSeq.map { "frame \($0)" } }
    return item.detail
  }

  private func color(_ tint: FeedTint) -> Color {
    switch tint {
    case .accent: return Theme.accent
    case .warn: return Theme.warn
    case .muted: return Theme.muted
    case .ok: return Theme.ok
    case .danger: return Theme.danger
    }
  }

  private func glyph(_ kind: FeedItem.Kind) -> String {
    switch kind {
    case .gate: return "viewfinder"
    case .identify: return "person.crop.circle.badge.questionmark"
    case .render: return "eye"
    case .session: return "play.circle"
    case .status: return "heart.text.square"
    case .info: return "info.circle"
    }
  }

  private func clock(_ date: Date) -> String {
    date.formatted(date: .omitted, time: .standard)
  }
}
