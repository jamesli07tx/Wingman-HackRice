// HudRenderer.swift — HudCard → DAT declarative display (DESIGN.md §4.2 renderer contract, §5.1 responsibility 3).
// The DAT display has NO partial updates: every send() replaces the whole 600×600 screen, so renders are
// coalesced to ≥ renderMinGapMs apart, always drawing the LATEST card. Devices are stateless renderers —
// Cortex owns rotation timing; same cardId + higher seq simply replaces the screen.
//
// Sends are SERIALIZED, not just rate-limited: a BLE send can outlast renderMinGapMs, and two overlapping
// full-screen replaces could land out of order (a stale card last). So the gap is measured from the
// COMPLETION of the previous draw, and while one is in flight new cards only replace `pending`.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator — render messages + armed.config.renderMinGapMs (shared/src/constants.ts RENDER_MIN_GAP_MS)
// CONTRACT: DESIGN.md §4.2 render / HudCard (title + subtitle + ≤ 5 lines ≈ 40 chars + footer) and Appendix D renderMinGapMs
// AT-INTEGRATION: verify the received armed.config.renderMinGapMs overrides the compiled 500 ms default (BridgeController logs both on arm); check card typography on-lens at M2.
//
// INTEGRATION: HudRenderer
// IN:  render(HudCard) from BridgeController on every `render` message; apply(renderMinGapMs:) on `armed`
// OUT: display.send(FlexBox) on the DAT Display (main queue), one at a time, ≥ renderMinGapMs apart
// WIRE: HudRenderer(display: dat.display, minGapMs: config.renderMinGapMs) after DATSessionManager.start()

import Foundation

// MARK: - Platform-neutral half (tested on macOS)

/// Coalesces draw requests onto one serial queue: at most one draw in flight, ≥ minGapMs between the
/// END of a draw and the start of the next, and the card drawn is always the newest one submitted by then.
/// `draw` MUST call its completion when the draw has actually finished — the next draw waits on it.
final class RenderCoalescer {
  private(set) var minGapMs: Int
  private(set) var drawCount = 0
  private let queue: DispatchQueue
  private let draw: (HudCard, @escaping () -> Void) -> Void
  private var lastDrawEnd = Date.distantPast
  private var pending: HudCard?
  private var inFlight = false
  private var timerArmed = false

  init(minGapMs: Int = ArmedConfig.defaults.renderMinGapMs,
       queue: DispatchQueue = .main,
       draw: @escaping (HudCard, @escaping () -> Void) -> Void) {
    self.minGapMs = minGapMs
    self.queue = queue
    self.draw = draw
  }

  func submit(_ card: HudCard) {
    queue.async {
      self.pending = card                                  // latest wins
      self.pump()
    }
  }

  /// Runtime retune from `armed.config` (server is authoritative). Hops to the coalescer's own queue —
  /// all state lives there, so callers never need to know which queue that is.
  func setMinGapMs(_ ms: Int) {
    queue.async {
      self.minGapMs = ms
      self.timerArmed = false   // a timer armed at the old gap is stale; its pump() is then a harmless no-op
      self.pump()
    }
  }

  /// Queue-only. Draws the newest pending card if nothing is in flight and the gap has elapsed;
  /// otherwise arms ONE timer for the remainder. Idempotent — safe to call from anywhere on the queue.
  private func pump() {
    guard !inFlight, let card = pending else { return }
    let waitedMs = Date().timeIntervalSince(lastDrawEnd) * 1000
    guard waitedMs >= Double(minGapMs) else {
      guard !timerArmed else { return }
      timerArmed = true
      queue.asyncAfter(deadline: .now() + max(0, Double(minGapMs) - waitedMs) / 1000) {
        self.timerArmed = false
        self.pump()
      }
      return
    }
    pending = nil
    inFlight = true
    drawCount += 1
    draw(card) { self.queue.async { self.finish() } }      // hopping done() back here is ours, not the caller's
  }

  private func finish() {
    guard inFlight else { return }                         // a double completion must not open a second slot
    inFlight = false
    lastDrawEnd = Date()                                   // gap measured from completion, not from issue
    pump()
  }
}

/// Defensive clipping so a card can never wrap-scroll on the 600×600 lens (Cortex enforces limits upstream).
enum HudText {
  static let maxLines = 5
  static let maxChars = 44        // contract says ≈ 40; small slack, then hard clip
  static let maxTitleChars = 28   // heading is the largest style — clips sooner

  static func clip(_ s: String, max: Int = maxChars) -> String {
    // Flatten newlines first: one line of text must never become extra rows on a screen that only scrolls.
    let flat = String(s.map { $0.isNewline ? " " : $0 })
    return flat.count <= max ? flat : String(flat.prefix(max - 1)) + "…"
  }

  static func lines(of card: HudCard) -> [String] {
    (card.lines ?? []).prefix(maxLines).map { clip($0) }
  }
}

// MARK: - DAT half (iOS app target only). Keep SwiftUI OUT of this file: DAT's Text/Image collide with SwiftUI's.

#if canImport(MWDATDisplay)
import MWDATDisplay

final class HudRenderer {
  private let display: Display
  private let coalescer: RenderCoalescer

  init(display: Display, minGapMs: Int = ArmedConfig.defaults.renderMinGapMs) {
    self.display = display
    self.coalescer = RenderCoalescer(minGapMs: minGapMs, queue: .main) { card, done in
      Task {
        defer { done() }   // the coalescer holds the next draw until the send has actually finished
        do { try await display.send(HudRenderer.flexBox(for: card)) }
        catch { NSLog("HudRenderer: display.send failed for \(card.cardId)#\(card.seq): \(error)") }
      }
    }
  }

  func apply(renderMinGapMs: Int) { coalescer.setMinGapMs(renderMinGapMs) }

  func render(_ card: HudCard) { coalescer.submit(card) }

  /// title (heading) / subtitle (secondary) / ≤ 5 lines (body) / footer (meta, secondary). Root must be a FlexBox.
  static func flexBox(for card: HudCard) -> FlexBox {
    FlexBox(direction: .column, spacing: 6, alignment: .start, crossAlignment: .stretch, padding: EdgeInsets(all: 24)) {
      Text(HudText.clip(card.title, max: HudText.maxTitleChars), style: .heading)
      if let subtitle = card.subtitle { Text(HudText.clip(subtitle), style: .body, color: .secondary) }
      for line in HudText.lines(of: card) { Text(line, style: .body) }
      if let footer = card.footer { Text(HudText.clip(footer), style: .meta, color: .secondary) }
    }
  }
}
#endif
