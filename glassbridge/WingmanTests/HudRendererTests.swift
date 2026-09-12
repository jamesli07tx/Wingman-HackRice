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
}
