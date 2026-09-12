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
    let c = RenderCoalescer(minGapMs: 500, queue: q) { drawn.append($0) }
    for i in 1...5 { c.submit(card(i)); Thread.sleep(forTimeInterval: 0.04) }   // 5 submits in ~200 ms
    Thread.sleep(forTimeInterval: 0.9)
    q.sync {}
    XCTAssertEqual(drawn.map(\.seq), [1, 5])
  }

  func testSpacedSubmitsDrawImmediately() {
    let q = DispatchQueue(label: "test.coalescer2")
    var drawn: [Int] = []
    let c = RenderCoalescer(minGapMs: 100, queue: q) { drawn.append($0.seq) }
    c.submit(card(1)); Thread.sleep(forTimeInterval: 0.15)
    c.submit(card(2)); Thread.sleep(forTimeInterval: 0.15)
    q.sync {}
    XCTAssertEqual(drawn, [1, 2])
  }

  func testMinGapCanBeRetunedAtRuntime() {
    let q = DispatchQueue(label: "test.coalescer3")
    var drawn: [Int] = []
    let c = RenderCoalescer(minGapMs: 2000, queue: q) { drawn.append($0.seq) }
    c.minGapMs = 50
    c.submit(card(1)); Thread.sleep(forTimeInterval: 0.02); c.submit(card(2))
    Thread.sleep(forTimeInterval: 0.2); q.sync {}
    XCTAssertEqual(drawn, [1, 2])
  }

  func testClipNeverExceedsMaxAndEndsWithEllipsis() {
    XCTAssertEqual(HudText.clip("short"), "short")
    let long = String(repeating: "x", count: 60)
    XCTAssertEqual(HudText.clip(long).count, 44)
    XCTAssertTrue(HudText.clip(long).hasSuffix("…"))
  }

  func testLinesCappedAtFive() {
    var c = card(1); c.lines = (1...8).map { "line \($0)" }
    XCTAssertEqual(HudText.lines(of: c).count, 5)
    c.lines = nil
    XCTAssertEqual(HudText.lines(of: c), [])
  }
}
