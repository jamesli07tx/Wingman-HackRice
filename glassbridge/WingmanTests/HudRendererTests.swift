import XCTest
#if canImport(WingmanCore)
@testable import WingmanCore
#else
@testable import Wingman
#endif

final class HudRendererTests: XCTestCase {
  private func card(_ n: Int) -> HudCard { HudCard(cardId: "c", seq: n, kind: .company, title: "T\(n)") }

  /// DESIGN_MAC.md §2.4: burst 5 renders in 200 ms → ≤ 1 screen replace per 500 ms, last card wins.
  func testBurstCoalescesToFirstThenLatest() {
    let q = DispatchQueue(label: "test.coalescer")
    var drawn: [HudCard] = []
    let c = RenderCoalescer(minGapMs: 500, queue: q) { card, done in drawn.append(card); done() }
    for i in 1...5 { c.submit(card(i)); Thread.sleep(forTimeInterval: 0.04) }   // 5 submits in ~200 ms
    Thread.sleep(forTimeInterval: 0.9)
    q.sync {}
    XCTAssertEqual(drawn.map(\.seq), [1, 5])
  }

  func testSpacedSubmitsDrawImmediately() {
    let q = DispatchQueue(label: "test.coalescer2")
    var drawn: [Int] = []
    let c = RenderCoalescer(minGapMs: 100, queue: q) { card, done in drawn.append(card.seq); done() }
    c.submit(card(1)); Thread.sleep(forTimeInterval: 0.15)
    c.submit(card(2)); Thread.sleep(forTimeInterval: 0.15)
    q.sync {}
    XCTAssertEqual(drawn, [1, 2])
  }

  func testMinGapCanBeRetunedAtRuntime() {
    let q = DispatchQueue(label: "test.coalescer3")
    var drawn: [Int] = []
    let c = RenderCoalescer(minGapMs: 2000, queue: q) { card, done in drawn.append(card.seq); done() }
    c.setMinGapMs(50)
    c.submit(card(1)); Thread.sleep(forTimeInterval: 0.02); c.submit(card(2))
    Thread.sleep(forTimeInterval: 0.2); q.sync {}
    XCTAssertEqual(drawn, [1, 2])
  }

  /// A BLE send can outlast minGapMs. Two full-screen replaces must never overlap (a stale card could land
  /// last), so cards submitted mid-flight only replace `pending` and the newest one draws after completion.
  func testSlowDrawSerializesAndOnlyLatestFollows() {
    let q = DispatchQueue(label: "test.coalescer4")
    let sender = DispatchQueue(label: "test.slowsend")
    var drawn: [Int] = []
    var inFlight = 0
    var maxInFlight = 0
    let c = RenderCoalescer(minGapMs: 100, queue: q) { card, done in
      drawn.append(card.seq)
      inFlight += 1
      maxInFlight = max(maxInFlight, inFlight)
      sender.asyncAfter(deadline: .now() + 0.3) {     // a 300 ms display.send — 3× minGapMs
        q.async { inFlight -= 1 }
        done()
      }
    }
    c.submit(card(1))                                            // starts the slow draw
    Thread.sleep(forTimeInterval: 0.05); c.submit(card(2))       // both land mid-flight
    Thread.sleep(forTimeInterval: 0.05); c.submit(card(3))
    Thread.sleep(forTimeInterval: 0.8)
    q.sync {}
    XCTAssertEqual(drawn, [1, 3])
    XCTAssertEqual(maxInFlight, 1)
  }

  func testClipNeverExceedsMaxAndEndsWithEllipsis() {
    XCTAssertEqual(HudText.clip("short"), "short")
    let long = String(repeating: "x", count: 60)
    XCTAssertEqual(HudText.clip(long).count, 44)
    XCTAssertTrue(HudText.clip(long).hasSuffix("…"))
  }

  /// A card line must never expand into extra rows on a screen that only scrolls vertically.
  func testClipFlattensNewlines() {
    XCTAssertEqual(HudText.clip("two\nrows"), "two rows")
    XCTAssertFalse(HudText.clip("a\r\nb\rc").contains(where: \.isNewline))
  }

  func testLinesCappedAtFive() {
    var c = card(1); c.lines = (1...8).map { "line \($0)" }
    XCTAssertEqual(HudText.lines(of: c).count, 5)
    c.lines = nil
    XCTAssertEqual(HudText.lines(of: c), [])
  }

  // MARK: row budget (measured on a Meta Ray-Ban Display: ≈ 38 chars/row, ≥ 8 body rows)

  /// Rows a fitted card's body will occupy on the lens.
  private func bodyRows(_ c: HudCard) -> Int {
    (c.subtitle.map(HudText.rows) ?? 0) + (c.lines ?? []).reduce(0) { $0 + HudText.rows($1) }
  }

  /// Exactly `n` chars of space-separated words, so a word-boundary clip has somewhere to land.
  private func words(_ n: Int) -> String { String(String(repeating: "word ", count: n / 5 + 1).prefix(n)) }

  /// A card that is legal per DESIGN.md §4.2 (5 lines ≈ 40 chars) is already 10 rows on the real lens —
  /// it must come back inside the budget WITHOUT losing a line.
  func testFitKeepsLegalCardWithinRowBudget() {
    var c = card(1)
    c.lines = (1...5).map { _ in words(40) }
    c.subtitle = words(48)
    let f = HudText.fit(c)
    XCTAssertEqual(f.lines?.count, 5)
    XCTAssertLessThanOrEqual(bodyRows(f), HudText.maxBodyRows)
  }

  /// Over-long lines are clipped to one row at a word boundary — and only as many of them as the budget
  /// needs: the squeeze stops the moment the card fits, so a card never loses more text than it must.
  func testFitClipsLongLinesAtWordBoundary() {
    var c = card(1)
    let long = words(60)
    c.lines = (1...5).map { _ in long }
    c.subtitle = words(48)
    let f = HudText.fit(c)
    XCTAssertEqual(f.lines?.count, 5)
    XCTAssertLessThanOrEqual(bodyRows(f), HudText.maxBodyRows)
    let clipped = (f.lines ?? []).filter { $0 != long }
    XCTAssertFalse(clipped.isEmpty)
    for l in clipped {
      XCTAssertLessThanOrEqual(l.count, HudText.bodyCharsPerRow)
      XCTAssertTrue(l.hasSuffix("…"))
      XCTAssertTrue(long.hasPrefix(String(l.dropLast())))      // cut at a word boundary, not mid-word
      XCTAssertFalse(l.dropLast().hasSuffix(" "))
    }
  }

  /// Lines too long to survive at all (6 rows each) are every one of them squeezed to a single row.
  func testFitSqueezesEveryLineWhenOneRowEachIsStillNeeded() {
    var c = card(1)
    c.lines = (1...5).map { _ in words(200) }
    c.subtitle = words(48)
    let f = HudText.fit(c)
    XCTAssertEqual(f.lines?.count, 5)
    XCTAssertTrue((f.lines ?? []).allSatisfy { $0.count <= HudText.bodyCharsPerRow && $0.hasSuffix("…") })
    XCTAssertLessThanOrEqual(bodyRows(f), HudText.maxBodyRows)
  }

  /// The subtitle is only sacrificed when the lines alone fill the budget — which 5 one-row lines never do.
  func testFitKeepsSubtitleWhenLinesFitInBudget() {
    var c = card(1)
    c.lines = (1...5).map { _ in words(60) }
    c.subtitle = words(48)
    XCTAssertNotNil(HudText.fit(c).subtitle)
  }

  func testFitClipsTitleAndFooter() {
    var c = card(1)
    c.title = String(repeating: "T", count: 30)
    c.footer = words(60)
    let f = HudText.fit(c)
    XCTAssertEqual(f.title.count, HudText.maxTitleChars)
    XCTAssertTrue(f.title.hasSuffix("…"))
    XCTAssertEqual(f.footer?.count, HudText.bodyCharsPerRow)
    XCTAssertTrue(f.footer?.hasSuffix("…") == true)
  }
}
