// Theme.swift — the whole visual system, in one file. Mirrors the web console in ui/ (ui/src/app/globals.css
// + ui/src/components/ui.tsx — the Confidanz product language): #F9F9F9 page ground, white cards on a soft
// shadow, navy ink #182849, product blue #4472C4 with pale blue #DFE7F5 for selected states, rounded-full bold
// buttons, light mode only. Roboto is not bundled on iOS, so SF at the same weights stands in. Every screen
// builds out of these; nothing here knows about Wingman.

import SwiftUI

enum Theme {
  /// #F9F9F9 — the page ground (ui: --ground). Set on a ZStack under every screen, never left transparent.
  static let bg = Color(red: 0.976, green: 0.976, blue: 0.976)
  /// #FFFFFF — cards (ui: --panel), lifted by `Theme.shadow`.
  static let surface = Color.white
  /// #F3F4F6 — chips, segmented grounds, secondary hovers (ui: --panel-2).
  static let field = Color(red: 0.953, green: 0.957, blue: 0.965)
  /// #4472C4 — product blue: primary buttons, the tab tint, focus (ui: --accent).
  static let accent = Color(red: 0.267, green: 0.447, blue: 0.769)
  /// #2B5797 — pressed / hover blue (ui: --accent-strong).
  static let accentStrong = Color(red: 0.169, green: 0.341, blue: 0.592)
  /// #DFE7F5 — pale blue: selected pills and chips (ui: --accent-deep).
  static let accentSoft = Color(red: 0.875, green: 0.906, blue: 0.961)
  /// #182849 — navy ink (ui: --fg).
  static let text = Color(red: 0.094, green: 0.157, blue: 0.286)
  /// #6B7280 (ui: --muted).
  static let muted = Color(red: 0.420, green: 0.447, blue: 0.502)
  /// #E5E7EB — rules and input borders (ui: --rule).
  static let hairline = Color(red: 0.898, green: 0.906, blue: 0.922)
  /// #D1D5DB — input border.
  static let inputBorder = Color(red: 0.820, green: 0.835, blue: 0.859)
  static let danger = Color(red: 0.863, green: 0.149, blue: 0.149)      // #DC2626
  static let dangerSoft = Color(red: 0.980, green: 0.827, blue: 0.827)  // #FAD3D3
  static let warn = Color(red: 0.675, green: 0.604, blue: 0.0)          // #AC9A00
  static let warnSoft = Color(red: 1.0, green: 0.996, blue: 0.863)      // #FFFEDC
  static let ok = Color(red: 0.196, green: 0.396, blue: 0.204)          // #326534
  static let okSoft = Color(red: 0.839, green: 0.929, blue: 0.843)      // #D6EDD7
  /// The dark bezel every lens replica sits in (ui/src/components/HudCardView.tsx #1B2026).
  static let bezel = Color(red: 0.106, green: 0.125, blue: 0.149)

  static let title = Font.system(.largeTitle).weight(.bold)
  static let section = Font.system(.title3).weight(.bold)
}

extension View {
  /// ui --shadow-2: the card elevation.
  func cardShadow() -> some View {
    self.shadow(color: .black.opacity(0.10), radius: 15, y: 10).shadow(color: .black.opacity(0.10), radius: 6, y: 4)
  }
  /// ui --shadow-1: chrome (the top bar).
  func chromeShadow() -> some View {
    self.shadow(color: .black.opacity(0.10), radius: 6, y: 4)
  }
}

// MARK: - Building blocks

/// A card: white on a soft shadow, bold navy title with an optional blue SF Symbol (ui Section).
struct Card<Content: View>: View {
  var title: String?
  var symbol: String?
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let title {
        HStack(spacing: 8) {
          if let symbol { Image(systemName: symbol).foregroundStyle(Theme.accent) }
          Text(title).font(Theme.section).foregroundStyle(Theme.text)
        }
      }
      content
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(20)
    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
    .cardShadow()
  }
}

/// Status pill (ui Chip): pale capsule, navy text, a coloured dot for the state.
struct Pill: View {
  let text: String
  var color: Color = Theme.muted

  init(_ text: String, _ color: Color = Theme.muted) {
    self.text = text
    self.color = color
  }

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 8, height: 8)
      Text(text).font(.caption.weight(.medium)).lineLimit(1).foregroundStyle(Theme.text)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 5)
    .background(Capsule().fill(Theme.field))
  }
}

/// A read-only chip — skills, interests (ui Chip tone "accent": pale blue, navy text).
struct Chip: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.caption.weight(.medium))
      .foregroundStyle(Theme.text)
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(Capsule().fill(Theme.accentSoft))
  }
}

/// ui Button primary: rounded-full, bold, product blue, white text; darker while pressed.
struct PrimaryButtonStyle: ButtonStyle {
  /// `.tint` does not reach a custom ButtonStyle, so the one destructive button passes its colour here.
  var color: Color = Theme.accent

  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.bold))
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 14)
      .background(Capsule().fill(configuration.isPressed ? color.opacity(0.85) : color))
      .opacity(isEnabled ? 1 : 0.7)
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// ui Button secondary: transparent with a 1 px inset ring, dark text.
struct GhostButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.bold))
      .foregroundStyle(isEnabled ? Color(red: 0.2, green: 0.2, blue: 0.2) : Theme.muted)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
      .background(Capsule().fill(configuration.isPressed ? Theme.field : Color.clear))
      .overlay(Capsule().strokeBorder(Color.black.opacity(0.15)))
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

extension View {
  /// Text fields, consistently (ui Input): white, 1 px grey border, rounded 8, navy text, blue caret.
  func wingmanField() -> some View {
    self
      .foregroundStyle(Theme.text)
      .tint(Theme.accent)
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.inputBorder))
  }
}

/// ui Notice: soft tinted block — red for "you must act", amber for "I am handling it", grey for "here is the next step".
struct Banner: View {
  enum Kind { case error, warning, note }

  let text: String
  var kind: Kind = .note

  private var ink: Color {
    switch kind {
    case .error: return Theme.danger
    case .warning: return Color(red: 0.478, green: 0.427, blue: 0.0)   // #7A6D00
    case .note: return Color(red: 0.294, green: 0.333, blue: 0.388)    // #4B5563
    }
  }
  private var ground: Color {
    switch kind {
    case .error: return Theme.dangerSoft
    case .warning: return Theme.warnSoft
    case .note: return Theme.field
    }
  }

  var body: some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(ink)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(RoundedRectangle(cornerRadius: 8).fill(ground))
  }
}

/// Small label over a value, used across the session strip.
struct Stat: View {
  let label: String
  let value: String

  init(_ label: String, _ value: String) {
    self.label = label
    self.value = value
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption2).foregroundStyle(Theme.muted)
      Text(value).font(.footnote.monospacedDigit()).foregroundStyle(Theme.text).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The wordmark, same as the console's NavBar: a product-blue diamond, then "Wingman" in bold navy.
struct Wordmark: View {
  var size: Font = Theme.title

  var body: some View {
    (Text("◆ ").foregroundColor(Theme.accent) + Text("Wingman").foregroundColor(Theme.text))
      .font(size)
      .kerning(-0.3)
  }
}
