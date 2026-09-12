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
///
/// Measured on a Meta Ray-Ban Display (DAT 0.9.0): body text wraps at word boundaries at ≈ 38 chars per row,
/// and ≈ 8 body rows fit under a heading and above a meta footer without scrolling. So a "legal" 5 × 40-char
/// card is already 10 rows — `fit` is what keeps it on one screen.
enum HudText {
  static let maxLines = 5
  static let maxChars = 44        // contract says ≈ 40; small slack, then hard clip
  static let maxTitleChars = 22   // heading is the largest style — clips sooner (measured on-lens)
  static let bodyCharsPerRow = 38 // body style wraps here (measured: a 40-char line wrapped before its last word)
  static let maxBodyRows = 8      // subtitle + lines together, excluding the heading and the footer

  /// One line of text must never become extra rows on a screen that only scrolls.
  private static func flatten(_ s: String) -> String { String(s.map { $0.isNewline ? " " : $0 }) }

  static func clip(_ s: String, max: Int = maxChars) -> String {
    let flat = flatten(s)
    return flat.count <= max ? flat : String(flat.prefix(max - 1)) + "…"
  }

  static func lines(of card: HudCard) -> [String] {
    (card.lines ?? []).prefix(maxLines).map { clip($0) }
  }

  /// Rows this string will occupy once the lens wraps it.
  static func rows(_ s: String) -> Int { max(1, (s.count + bodyCharsPerRow - 1) / bodyCharsPerRow) }

  /// Clip to one row, ending at a word boundary so the "…" never lands mid-word. Result ≤ `max` chars.
  private static func wordClip(_ s: String, max: Int = bodyCharsPerRow) -> String {
    guard s.count > max else { return s }
    let head = s.prefix(max - 1)
    let cut = head.lastIndex(of: " ").map { head[head.startIndex..<$0] } ?? head[...]
    return cut.trimmingCharacters(in: .whitespaces) + "…"
  }

  /// Whole-card fit: title + footer clipped, body squeezed to `maxBodyRows`. Squeezing clips the LONGEST
  /// remaining body string to one row at a time, so a card loses its wordiest line before its shortest.
  static func fit(_ card: HudCard) -> HudCard {
    var out = card
    out.title = clip(card.title, max: maxTitleChars)
    out.footer = card.footer.map { clip($0, max: bodyCharsPerRow) }

    var subtitle = card.subtitle.map(flatten)
    var lines = (card.lines ?? []).prefix(maxLines).map(flatten)
    func usedRows() -> Int { (subtitle.map(rows) ?? 0) + lines.reduce(0) { $0 + rows($1) } }

    while usedRows() > maxBodyRows {
      // Longest first; the subtitle is the tie-breaker winner, so lines are only clipped when actually longer.
      var idx = -1                                   // -1 = the subtitle
      var len = subtitle?.count ?? -1
      for (i, l) in lines.enumerated() where l.count > len { len = l.count; idx = i }
      guard len > bodyCharsPerRow else { break }     // everything is already one row — nothing left to clip
      if idx < 0 { subtitle = wordClip(subtitle!) } else { lines[idx] = wordClip(lines[idx]) }
    }
    // ponytail: both drops are unreachable at 5 lines × 1 row ≤ 8 rows — the belt for a constants bump.
    if usedRows() > maxBodyRows { subtitle = nil }
    while usedRows() > maxBodyRows, !lines.isEmpty { lines.removeLast() }

    out.subtitle = subtitle
    out.lines = card.lines == nil ? nil : lines
    return out
  }
}

// MARK: - DAT half (iOS app target only). Keep SwiftUI OUT of this file: DAT's Text/Image collide with SwiftUI's.

#if canImport(MWDATDisplay)
import MWDATDisplay

/// Layout variants, compared on real hardware via DisplayPlayground (Debug). `.card` is the shipping layout
/// (picked on-lens); the others exist only so a human wearing the glasses can compare.
enum HudStyle: String, CaseIterable { case plain, card, icon, iconCard }

final class HudRenderer {
  private let display: Display
  /// IUO so the draw closure below can read `self.style` — `style` is chosen per-draw, not frozen at init.
  private var coalescer: RenderCoalescer!
  /// Read on the coalescer's queue (.main), written from the main actor. Playground-only in practice.
  var style: HudStyle = .card
  /// Playground fit probes render unclipped; production leaves this true.
  var clip = true

  init(display: Display, minGapMs: Int = ArmedConfig.defaults.renderMinGapMs) {
    self.display = display
    self.coalescer = RenderCoalescer(minGapMs: minGapMs, queue: .main) { [weak self] card, done in
      let style = self?.style ?? .plain      // read before the Task: only Sendable values cross into it
      let clip = self?.clip ?? true
      Task {
        defer { done() }   // the coalescer holds the next draw until the send has actually finished
        do { try await display.send(HudRenderer.flexBox(for: card, style: style, clip: clip)) }
        catch { NSLog("HudRenderer: display.send failed for \(card.cardId)#\(card.seq): \(error)") }
      }
    }
  }

  func apply(renderMinGapMs: Int) { coalescer.setMinGapMs(renderMinGapMs) }

  func render(_ card: HudCard) { coalescer.submit(card) }

  /// The closest IconName the SDK ships for each kind (docs/dat-0.9.0-api-notes.md §6 — there is no
  /// document/hourglass glyph; `.fourCornerFrame` is the scan viewfinder, `.museumBuilding` the only building).
  static func icon(for kind: CardKind) -> IconName {
    switch kind {
    case .ack: return .clock
    case .company: return .museumBuilding
    case .pitch: return .star
    case .scan: return .fourCornerFrame
    case .hint: return .lightBulb
    case .error: return .exclamationTriangle
    }
  }

  /// title (heading) / subtitle (secondary) / ≤ 5 lines (body) / footer (meta, secondary). Root must be a FlexBox.
  /// `.icon*` styles move the title into a row next to a kind icon; `.card*` put the whole thing on a card background.
  /// `clip: false` renders the card exactly as given (playground fit probes); production runs HudText.fit.
  static func flexBox(for card: HudCard, style: HudStyle = .plain, clip: Bool = true) -> FlexBox {
    let c = clip ? HudText.fit(card) : card
    let lines = c.lines ?? []
    let titleText = Text(c.title, style: .heading)
    let withIcon = (style == .icon || style == .iconCard)
    let root = FlexBox(direction: .column, spacing: 6, alignment: .start, crossAlignment: .stretch, padding: EdgeInsets(all: 24)) {
      if withIcon {
        FlexBox(direction: .row, spacing: 12, crossAlignment: .center) {
          Icon(name: HudRenderer.icon(for: card.kind))
          titleText
        }
      } else {
        titleText
      }
      if let subtitle = c.subtitle { Text(subtitle, style: .body, color: .secondary) }
      for line in lines { Text(line, style: .body) }
      if let footer = c.footer { Text(footer, style: .meta, color: .secondary) }
    }
    return (style == .card || style == .iconCard) ? root.background(.card) : root
  }
}
#endif
