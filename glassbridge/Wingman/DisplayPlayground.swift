// DisplayPlayground.swift — Debug-only deck of real HudCards to flip through ON the lens, so a human wearing the
// glasses can judge legibility/typography/style without Cortex, a session, or a network (DESIGN_MAC.md M2
// "check card typography on-lens"). Every page is a valid DESIGN.md §4.2 HudCard: title ≤ 28 chars, ≤ 5 lines
// of ≈ 40 chars. Pair it with HudRenderer.HudStyle to compare plain / card / icon / iconCard on real hardware.
//
// INTEGRATION: DisplayPlayground
// IN:  BridgeController.playgroundShow/playgroundSleepTest (Session → Debug tools)
// OUT: HudCard values only — no DAT calls of its own
// WIRE: pure data; the whole file compiles to nothing where MWDATDisplay is absent (macOS `swift build`).

#if canImport(MWDATDisplay)
import Foundation

enum DisplayPlayground {
  /// Ordered deck. Index 0 and 1 are the two pages of one rotation — playgroundSleepTest() uses exactly those.
  static let pages: [(name: String, card: HudCard)] = [
    // (a) the DESIGN.md §4.2 example card, verbatim.
    ("Stripe 1/2", HudCard(
      cardId: "c_007", seq: 3, kind: .company,
      title: "Stripe",
      subtitle: "Payments infrastructure for the internet",
      lines: ["Hiring: SWE Intern, New Grad Backend",
              "Stack: Ruby, Go, ML infra at scale",
              "Recently: launched usage-based billing APIs"],
      footer: "Wingman · 1/2",
      page: .init(index: 1, count: 2), streaming: false,
      company: .init(companyId: "stripe", confidence: 0.93), minDisplaySec: 15)),

    // (b) page 2 of the same rotation — same cardId, next seq (DESIGN.md §4.2 "higher seq = replace in place").
    ("Stripe pitch 2/2", HudCard(
      cardId: "c_007", seq: 4, kind: .pitch,
      title: "Stripe",
      subtitle: "Your pitch",
      lines: ["Ask about idempotency keys at scale",
              "You shipped a Stripe-webhook replayer",
              "Close: \"who owns billing reliability?\""],
      footer: "Wingman · 2/2",
      page: .init(index: 2, count: 2), streaming: false,
      company: .init(companyId: "stripe", confidence: 0.93), minDisplaySec: 15)),

    ("Ack", HudCard(cardId: "c_ack", seq: 1, kind: .ack,
                    title: "Identifying…", footer: "Wingman")),

    ("Scan", HudCard(cardId: "c_scan", seq: 1, kind: .scan,
                     title: "Pamphlet",
                     lines: ["Roles: SWE Intern (Summer 2027)",
                             "Deadline: Oct 15",
                             "Contact: campus@stripe.com"],
                     footer: "Wingman")),

    ("Error", HudCard(cardId: "c_err", seq: 1, kind: .error,
                      title: "Search unavailable",
                      lines: ["Showing cached info"])),

    ("Hint", HudCard(cardId: "c_hint", seq: 1, kind: .hint,
                     title: "Look at a booth banner",
                     lines: ["Hold steady ~2 s", "Cards appear automatically"])),

    // (g) worst case the contract allows: 5 lines × exactly 40 chars. If this wraps, the real limit is lower.
    ("Dense 5×40", HudCard(cardId: "c_dense", seq: 1, kind: .company,
                           title: "Ramp",
                           subtitle: "Corporate cards and spend management",
                           lines: ["Hiring: SWE Intern, New Grad Backend NYC",
                                   "Stack: TypeScript, Go, Postgres + Kafka.",
                                   "Recently: shipped agentic bill-pay tools",
                                   "Booth 14 - ask for Dana or Luis by 3 pm.",
                                   "Angle: your receipts-OCR side project!!!"],
                           footer: "Wingman · 1/3")),

    // (h) both over the clip thresholds (28 title / 44 line) — proves HudText.clip, not the lens, truncates.
    ("Long title clip", HudCard(cardId: "c_clip", seq: 1, kind: .company,
                                title: "Hyperscale Quantum Logistics Interstellar Incorporated Corp.",
                                subtitle: "We build the platform that powers the platform that you use.",
                                lines: ["Short line for contrast"],
                                footer: "Wingman")),

    // (i) the hour-zero spike card (BridgeController.runSpike), minus its live frame counts.
    ("Hello world", HudCard(cardId: "spike", seq: 1, kind: .hint,
                            title: "Wingman", subtitle: "hello, world",
                            lines: ["camera stream: OK", "decoded: OK", "display: sent"],
                            footer: "hour-zero spike")),
    // ---- FIT PROBES (measurement pass, DESIGN.md §4.2 600×600 contract). Rendered UNCLIPPED by the playground so the
    // human can read the first line/char count that wraps or scrolls off the lens. Not valid §4.2 cards on purpose.
    ("Probe: 6 body lines", HudCard(cardId: "p_l6", seq: 1, kind: .hint, title: "Six lines", lines: (1...6).map { "Line \($0) of six · quick brown fox jumps" }, footer: "footer")),
    ("Probe: 7 body lines", HudCard(cardId: "p_l7", seq: 1, kind: .hint, title: "Seven lines", lines: (1...7).map { "Line \($0) of seven · quick brown fox jumps" }, footer: "footer")),
    ("Probe: 8 body lines", HudCard(cardId: "p_l8", seq: 1, kind: .hint, title: "Eight lines", lines: (1...8).map { "Line \($0) of eight · quick brown fox jumps" }, footer: "footer")),
    // Real words, breakable at spaces (the lens wraps at word boundaries only). Each line's length is its prefix.
    ("Probe: chars/line 36-56", HudCard(cardId: "p_ch", seq: 1, kind: .hint, title: "Chars per line", lines: [
      "36: Hiring SWE interns for summer now",
      "40: Stack is Ruby, Go and ML infra at scale",
      "44: Recently launched usage-based billing APIs!!",
      "48: Booth 42, ask for Sam about the new grad roles",
      "52: Apply by October fifteenth via the careers portal!!"], footer: "first line to wrap = the cap")),
    ("Probe: worst legal card", HudCard(cardId: "p_wl", seq: 1, kind: .company, title: "Twenty-eight char title!!!!!",
      subtitle: "Subtitle at forty-eight characters long here!!!!",
      lines: ["Hiring: SWE Intern, New Grad Backend +40",
              "Stack: Ruby, Go, ML infra at scale ++40!",
              "Recently: launched usage-based billing.",
              "Office: Houston, Austin, Seattle, NYC!!!",
              "Apply by Oct 15 · booth 42 · ask for Sam"],
      footer: "Wingman · 1/2 · footer at forty chars!!")),
    ("Probe: text styles", HudCard(cardId: "p_ts", seq: 1, kind: .hint, title: "HEADING style sample Ag",
      subtitle: "body secondary style sample Ag", lines: ["body primary style sample Ag 0123456789"], footer: "meta secondary style sample Ag 0123456789")),

  ]
}
#endif
