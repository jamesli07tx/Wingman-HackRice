// Theme.swift — the whole visual system, in one file: a dark navy ground, one teal accent, card
// surfaces a shade lighter than the ground, rounded SF Pro titles, and the capsule status pills the
// old StatusView already used. Every screen builds out of these; nothing here knows about Wingman.

import SwiftUI

enum Theme {
  /// #0B1730 — the ground. Set on a ZStack under every screen, never left transparent.
  static let bg = Color(red: 0.043, green: 0.090, blue: 0.188)
  /// #13223E — cards, one shade up from the ground.
  static let surface = Color(red: 0.075, green: 0.133, blue: 0.243)
  /// #1B2D4E — chips and fields inside a card.
  static let field = Color(red: 0.106, green: 0.176, blue: 0.306)
  /// #06B6D4 — the one accent. Primary buttons, the tab tint, focus.
  static let accent = Color(red: 0.024, green: 0.714, blue: 0.831)
  static let text = Color.white
  static let muted = Color.white.opacity(0.58)
  static let hairline = Color.white.opacity(0.10)
  static let danger = Color(red: 0.96, green: 0.35, blue: 0.38)
  static let warn = Color(red: 0.98, green: 0.72, blue: 0.30)
  static let ok = Color(red: 0.25, green: 0.85, blue: 0.60)

  static let title = Font.system(.largeTitle, design: .rounded).weight(.bold)
  static let section = Font.system(.title3, design: .rounded).weight(.semibold)
}

// MARK: - Building blocks

/// A card: rounded navy surface, optional SF Symbol + title.
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
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 18).fill(Theme.surface))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.hairline))
  }
}

/// The capsule status pill carried over from the old StatusView: a coloured dot plus one short label.
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
      Text(text).font(.caption).lineLimit(1).foregroundStyle(Theme.text.opacity(0.9))
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(Capsule().fill(Theme.field))
  }
}

/// A read-only chip — skills, interests.
struct Chip: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.caption.weight(.medium))
      .foregroundStyle(Theme.accent)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(Capsule().fill(Theme.accent.opacity(0.14)))
  }
}

struct PrimaryButtonStyle: ButtonStyle {
  /// `.tint` does not reach a custom ButtonStyle, so the one destructive button passes its colour here.
  var color: Color = Theme.accent

  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.semibold))
      .foregroundStyle(isEnabled ? Color.black.opacity(0.88) : Theme.muted)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 14)
      .background(Capsule().fill(isEnabled ? color : Theme.field))
      .opacity(configuration.isPressed ? 0.75 : 1)
  }
}

struct GhostButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.medium))
      .foregroundStyle(isEnabled ? Theme.text : Theme.muted)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
      .background(Capsule().fill(Theme.field))
      .opacity(configuration.isPressed ? 0.75 : 1)
  }
}

extension View {
  /// Text fields, consistently: navy pill, teal caret, white text.
  func wingmanField() -> some View {
    self
      .foregroundStyle(Theme.text)
      .tint(Theme.accent)
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .background(RoundedRectangle(cornerRadius: 12).fill(Theme.field))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.hairline))
  }
}

/// Red for "you must act", amber for "I am handling it", grey for "here is the next step".
struct Banner: View {
  enum Kind { case error, warning, note }

  let text: String
  var kind: Kind = .note

  private var color: Color {
    switch kind {
    case .error: return Theme.danger
    case .warning: return Theme.warn
    case .note: return Theme.muted
    }
  }

  var body: some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(kind == .note ? Theme.muted : color)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(kind == .note ? 0.06 : 0.14)))
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

/// The wordmark: "Wing" in white, "man" in teal, rounded and tight.
struct Wordmark: View {
  var size: Font = Theme.title

  var body: some View {
    (Text("Wing").foregroundColor(Theme.text) + Text("man").foregroundColor(Theme.accent))
      .font(size)
      .kerning(-0.5)
  }
}
