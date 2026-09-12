// FeedView.swift — the observability window (DESIGN.md §4.3), on the wearer's own phone: per sent frame,
// what Cortex's models made of it. This is the console's /feed, for the person wearing the glasses —
// the answer to "is recognition actually working, or am I filming a wall?"
//
// INTEGRATION: FeedView
// IN:  bridge.feed / gateStats / lastGate / gateConfig / gateLatencyAvgMs / dashboardState / gateSilent / armed / framesSent
// OUT: bridge.clearFeed()
// WIRE: RootView tab 4

import SwiftUI
import UIKit

@MainActor
struct FeedView: View {
  @EnvironmentObject private var bridge: BridgeController
  @State private var gatePanelOpen = false
  @State private var promptOpen = false
  /// Gate rows the wearer has tapped open. FeedItem ids, so a row keeps its state as the feed grows.
  @State private var expanded: Set<UUID> = []

  var body: some View {
    VStack(spacing: 16) {
      gatePanel
      counters
      rows
    }
  }

  // MARK: the gate model itself
  //
  // The prompt is Cortex's, not this app's, so the only honest source is what Cortex just sent: every
  // gate_debug refreshes this panel. "Nothing is being recognised" is usually a prompt question, and this
  // is where you read the prompt without an SSH session.

  @ViewBuilder
  private var gatePanel: some View {
    if let config = bridge.gateConfig {
      Card {
        DisclosureGroup(isExpanded: $gatePanelOpen) {
          VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
              GridRow {
                Stat("Avg latency (20)", bridge.gateLatencyAvgMs.map { String(format: "%.1f s", Double($0) / 1000) } ?? "—")
                Stat("No JSON", "\(bridge.gateStats.empty)")
                Stat("Errors", "\(bridge.gateStats.errors)")
              }
            }
            DisclosureGroup("System prompt", isExpanded: $promptOpen) {
              VStack(alignment: .leading, spacing: 8) {
                prompt(config.systemPrompt)
                Text("User text").font(.caption2).foregroundStyle(Theme.muted)
                prompt(config.userText)
              }
              .padding(.top, 8)
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.text)
          }
          .padding(.top, 10)
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "brain").foregroundStyle(Theme.accent)
            Text("Gate model").font(Theme.section).foregroundStyle(Theme.text)
            Spacer(minLength: 8)
            Text(config.model).font(.caption.monospaced()).foregroundStyle(Theme.muted).lineLimit(1)
          }
        }
        .tint(Theme.accent)
      }
    }
  }

  /// Full prompt text, selectable — you copy it into the Cortex repo when it turns out to be the problem.
  private func prompt(_ text: String) -> some View {
    Text(text.isEmpty ? "—" : text)
      .font(.system(.caption2, design: .monospaced))
      .foregroundStyle(Theme.text.opacity(0.85))
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(RoundedRectangle(cornerRadius: 10).fill(Theme.field))
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
        GridRow {
          Stat("empty", "\(bridge.gateStats.empty)")
          Stat("errors", "\(bridge.gateStats.errors)")
          Color.clear.frame(height: 0)
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
    let isOpen = expanded.contains(item.id)
    return VStack(alignment: .leading, spacing: 10) {
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
          // What the gate call cost, and — in red — why it produced nothing.
          if let debug = item.gateDebug {
            Text(debug.summary).font(.caption2.monospaced()).foregroundStyle(Theme.muted).lineLimit(1)
            if let note = debug.note {
              Text(note)
                .font(.caption2)
                .foregroundStyle(Theme.danger)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.danger.opacity(0.14)))
            }
          }
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 2) {
          Text(clock(item.time)).font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted)
          // Gate rows carry the round trip: frame sent → Cortex's verdict.
          if item.kind == .gate, let latency = item.detail {
            Text(latency).font(.caption2.monospacedDigit()).foregroundStyle(Theme.accent)
          }
          if item.gateDebug != nil {
            Image(systemName: isOpen ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(Theme.muted)
          }
        }
      }
      if isOpen, let debug = item.gateDebug { expansion(item, debug) }
    }
    .padding(.vertical, 8)
    .contentShape(Rectangle())
    .onTapGesture {
      guard item.gateDebug != nil else { return }
      if isOpen { expanded.remove(item.id) } else { expanded.insert(item.id) }
    }
  }

  /// One whole gate call: the frame it judged and the model's raw text — the difference between
  /// "the prompt is wrong" and "the model never answered".
  private func expansion(_ item: FeedItem, _ debug: GateDebug) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if let image = item.thumbnail {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: .infinity)
          .clipShape(RoundedRectangle(cornerRadius: 12))
      }
      Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
        GridRow {
          Stat("Latency", debug.latencyText)
          Stat("Tokens", debug.tokensText ?? "—")
          Stat("Stop", debug.stopReason ?? "—")
        }
      }
      Text("Raw response").font(.caption2).foregroundStyle(Theme.muted)
      Text(debug.rawResponse ?? "— the model returned no text —")
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(debug.rawResponse == nil ? Theme.danger : Theme.text.opacity(0.85))
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.field))
      if let error = debug.error { Banner(text: error, kind: .error) }
    }
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
