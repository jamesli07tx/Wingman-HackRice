// ProfileView.swift — what Cortex knows about you: the resume PDF (uploaded here, parsed there, shown
// back here) and the four links. This is the screen that replaced the Next.js console for the wearer.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/rest/routes.ts POST /api/profile/resume, PUT /api/profile/links, GET /api/profile
// CONTRACT: DESIGN.md §4.1 — multipart PDF → { profile: ProfileSummary }; links are all optional strings
// AT-INTEGRATION: upload one real PDF and read the parsed name/headline/skills back on this screen.
//   Nothing renders = the parse returned an empty ProfileSummary, which is a Cortex-side problem.
//
// INTEGRATION: ProfileView
// IN:  bridge.profile / bridge.links / bridge.profileStatus
// OUT: bridge.uploadResume(_:) / bridge.saveLinks()
// WIRE: RootView tab 1

import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct ProfileView: View {
  @EnvironmentObject private var bridge: BridgeController
  @State private var importing = false
  @State private var readError: String?

  var body: some View {
    VStack(spacing: 16) {
      resumeCard
      if let profile = bridge.profile { parsedCard(profile) }
      linksCard
    }
  }

  // MARK: resume

  private var resumeCard: some View {
    Card(title: "Resume", symbol: "doc.text") {
      Text(bridge.profile == nil
           ? "Drop in your resume PDF. Cortex parses it once and the glasses use it for the whole session."
           : "Uploading a new PDF replaces what Cortex has.")
        .font(.footnote).foregroundStyle(Theme.muted)
        .fixedSize(horizontal: false, vertical: true)

      Button { importing = true } label: {
        HStack(spacing: 8) {
          if bridge.profileBusy { ProgressView().controlSize(.small).tint(.black) }
          Text(bridge.profile == nil ? "Choose PDF" : "Replace PDF")
        }
      }
      .buttonStyle(PrimaryButtonStyle())
      .disabled(bridge.profileBusy || !bridge.accountReady)

      if !bridge.accountReady {
        Banner(text: "Cortex URL is not set for this build — Debug tools on the Session tab can paste one.")
      }
      if let readError { Banner(text: readError, kind: .error) }
      if let status = bridge.profileStatus {
        Banner(text: status, kind: status.hasPrefix("Cortex") ? .error : .note)
      }
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf]) { result in
      readError = nil
      switch result {
      case let .success(url):
        // A file picked outside our container is security-scoped: read it inside the access window.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
          let data = try Data(contentsOf: url)
          Task { await bridge.uploadResume(data) }
        } catch {
          readError = "Could not read that PDF: \(error.localizedDescription)"
        }
      case let .failure(error):
        readError = error.localizedDescription
      }
    }
  }

  // MARK: what came back

  private func parsedCard(_ profile: ProfileSummary) -> some View {
    Card(title: "Profile ready", symbol: "checkmark.seal") {
      if let name = profile.name {
        Text(name).font(.system(.title2, design: .rounded).weight(.bold)).foregroundStyle(Theme.text)
      }
      if let headline = profile.headline {
        Text(headline).font(.subheadline).foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
      chips("Skills", profile.skills)
      chips("Interests", profile.interests)

      if let experiences = profile.experiences, !experiences.isEmpty {
        Text("Experience").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
        ForEach(experiences) { exp in
          VStack(alignment: .leading, spacing: 2) {
            Text([exp.role, exp.org].compactMap { $0 }.joined(separator: " · "))
              .font(.footnote.weight(.semibold)).foregroundStyle(Theme.text)
            if let highlight = exp.highlight {
              Text(highlight).font(.caption).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  @ViewBuilder private func chips(_ title: String, _ values: [String]?) -> some View {
    if let values, !values.isEmpty {
      Text(title).font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 78), spacing: 8, alignment: .leading)],
                alignment: .leading, spacing: 8) {
        ForEach(values, id: \.self) { Chip(text: $0) }
      }
    }
  }

  // MARK: links

  private var linksCard: some View {
    Card(title: "Links", symbol: "link") {
      field("LinkedIn", \.linkedin)
      field("X", \.x)
      field("GitHub", \.github)
      field("Website", \.website)

      Button {
        Task { await bridge.saveLinks() }
      } label: {
        Text("Save links")
      }
      .buttonStyle(GhostButtonStyle())
      .disabled(bridge.profileBusy || !bridge.accountReady)
    }
  }

  /// ponytail: one binding helper instead of four hand-written get/set pairs. Empty reads back as nil,
  /// so a blank field is OMITTED from the PUT rather than saved as "".
  private func field(_ label: String, _ key: WritableKeyPath<ProfileLinks, String?>) -> some View {
    TextField("", text: Binding(
      get: { bridge.links[keyPath: key] ?? "" },
      set: { bridge.links[keyPath: key] = $0.isEmpty ? nil : $0 }
    ), prompt: Text(label).foregroundColor(Theme.muted))
    .textContentType(.URL)
    .keyboardType(.URL)
    .textInputAutocapitalization(.never)
    .autocorrectionDisabled()
    .font(.footnote)
    .wingmanField()
  }
}
