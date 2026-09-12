// HudRenderer.swift — HudCard → DAT declarative display (DESIGN.md §4.2 renderer contract, §5.1 responsibility 3).
// The DAT display has NO partial updates: every send() replaces the whole 600×600 screen, so renders are
// coalesced to ≥ renderMinGapMs apart, always drawing the LATEST card. Devices are stateless renderers —
// Cortex owns rotation timing; same cardId + higher seq simply replaces the screen.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex SessionOrchestrator — render messages + armed.config.renderMinGapMs (shared/src/constants.ts RENDER_MIN_GAP_MS)
// CONTRACT: DESIGN.md §4.2 render / HudCard (title + subtitle + ≤ 5 lines ≈ 40 chars + footer) and Appendix D renderMinGapMs
// AT-INTEGRATION: verify the received armed.config.renderMinGapMs overrides the compiled 500 ms default (BridgeController logs both on arm); check card typography on-lens at M2.
//
// INTEGRATION: HudRenderer
// IN:  render(HudCard) from BridgeController on every `render` message; apply(renderMinGapMs:) on `armed`
// OUT: display.send(FlexBox) on the DAT Display (main queue), at most one per renderMinGapMs
// WIRE: HudRenderer(display: dat.display, minGapMs: config.renderMinGapMs) after DATSessionManager.start()

import Foundation

// MARK: - Platform-neutral half (tested on macOS)

/// Coalesces draw requests: draws immediately when ≥ minGapMs since the last draw, otherwise
/// schedules ONE deferred draw at lastDraw + minGapMs carrying whatever card is newest by then.
final class RenderCoalescer {
  var minGapMs: Int
  private(set) var drawCount = 0
  private let queue: DispatchQueue
  private let draw: (HudCard) -> Void
  private var lastDraw = Date.distantPast
  private var pending: HudCard?
  private var timerArmed = false

  init(minGapMs: Int = ArmedConfig.defaults.renderMinGapMs, queue: DispatchQueue = .main, draw: @escaping (HudCard) -> Void) {
    self.minGapMs = minGapMs
    self.queue = queue
    self.draw = draw
  }

  func submit(_ card: HudCard) {
    queue.async {
      let now = Date()
      let elapsedMs = now.timeIntervalSince(self.lastDraw) * 1000
      if elapsedMs >= Double(self.minGapMs) && self.pending == nil {
        self.lastDraw = now
        self.drawCount += 1
        self.draw(card)
        return
      }
      self.pending = card                                  // latest wins
      guard !self.timerArmed else { return }
      self.timerArmed = true
      let delay = max(0, Double(self.minGapMs) / 1000 - elapsedMs / 1000)
      self.queue.asyncAfter(deadline: .now() + delay) {
        self.timerArmed = false
        guard let c = self.pending else { return }
        self.pending = nil
        self.lastDraw = Date()
        self.drawCount += 1
        self.draw(c)
      }
    }
  }
}

/// Defensive clipping so a card can never wrap-scroll on the 600×600 lens (Cortex enforces limits upstream).
enum HudText {
  static let maxLines = 5
  static let maxChars = 44   // contract says ≈ 40; small slack, then hard clip

  static func clip(_ s: String, max: Int = maxChars) -> String {
    s.count <= max ? s : String(s.prefix(max - 1)) + "…"
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
    self.coalescer = RenderCoalescer(minGapMs: minGapMs, queue: .main) { card in
      Task {
        do { try await display.send(HudRenderer.flexBox(for: card)) }
        catch { NSLog("HudRenderer: display.send failed for \(card.cardId)#\(card.seq): \(error)") }
      }
    }
  }

  func apply(renderMinGapMs: Int) { DispatchQueue.main.async { self.coalescer.minGapMs = renderMinGapMs } }

  func render(_ card: HudCard) { coalescer.submit(card) }

  /// title (heading) / subtitle (secondary) / ≤ 5 lines (body) / footer (meta, secondary). Root must be a FlexBox.
  static func flexBox(for card: HudCard) -> FlexBox {
    FlexBox(direction: .column, spacing: 6, alignment: .start, crossAlignment: .stretch, padding: EdgeInsets(all: 24)) {
      Text(HudText.clip(card.title, max: 28), style: .heading)
      if let subtitle = card.subtitle { Text(HudText.clip(subtitle), style: .body, color: .secondary) }
      for line in HudText.lines(of: card) { Text(line, style: .body) }
      if let footer = card.footer { Text(HudText.clip(footer), style: .meta, color: .secondary) }
    }
  }
}
#endif
