// FairView.swift — pre-fair exhibitor list import from the phone: paste the exhibitor page link or pick a roster
// screenshot; Cortex extracts the names, researches each new company (Tavily + Claude) into the corpus, and reloads
// the identify list live. Nothing here touches the glasses path — booths not on the list are still researched live.
//
// INTEGRATION: FairView
// IN:  bridge.fairImport / fairBusy / fairStatus
// OUT: bridge.startFairImport(link:fairName:) / startFairImport(image:filename:contentType:fairName:) / refreshFairImport()
// COUNTERPART: cortex/src/fairs/routes.ts (same routes the web console's /fair page uses)

import PhotosUI
import SwiftUI

struct FairView: View {
  @EnvironmentObject private var bridge: BridgeController
  @State private var fairName = ""
  @State private var link = ""
  @State private var picked: PhotosPickerItem?
  @State private var readError: String?

  var body: some View {
    VStack(spacing: 16) {
      importCard
      if let imp = bridge.fairImport { resultCard(imp) }
    }
    .task { await bridge.refreshFairImport() }
  }

  private var importCard: some View {
    Card(title: "Fair list", symbol: "building.2") {
      Text("Drop in the exhibitor or sponsor list before the fair. Every company gets researched and its brief is ready on the glasses before you walk in.")
        .font(.footnote).foregroundStyle(Theme.muted)
        .fixedSize(horizontal: false, vertical: true)

      TextField("", text: $fairName, prompt: Text("Fair name (optional)").foregroundColor(Theme.muted))
        .font(.footnote).wingmanField()
      TextField("", text: $link, prompt: Text("Exhibitor page link").foregroundColor(Theme.muted))
        .textContentType(.URL).keyboardType(.URL)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .font(.footnote).wingmanField()

      Button {
        Task { await bridge.startFairImport(link: link.trimmingCharacters(in: .whitespacesAndNewlines), fairName: fairName) }
      } label: {
        HStack(spacing: 8) {
          if bridge.fairBusy { ProgressView().controlSize(.small).tint(.black) }
          Text("Import from link")
        }
      }
      .buttonStyle(PrimaryButtonStyle())
      .disabled(bridge.fairBusy || !bridge.accountReady || link.trimmingCharacters(in: .whitespaces).isEmpty)

      PhotosPicker(selection: $picked, matching: .images) {
        Text("Import from a screenshot").frame(maxWidth: .infinity)
      }
      .buttonStyle(GhostButtonStyle())
      .disabled(bridge.fairBusy || !bridge.accountReady)
      .onChange(of: picked) { _, item in
        guard let item else { return }
        readError = nil
        Task {
          guard let data = try? await item.loadTransferable(type: Data.self) else {
            readError = "Could not read that image"; return
          }
          // The route sniffs the real type; the name only labels the import.
          await bridge.startFairImport(image: data, filename: "roster.jpg", contentType: "image/jpeg", fairName: fairName)
          picked = nil
        }
      }

      if !bridge.accountReady {
        Banner(text: "Sign in and set the Cortex URL first.")
      }
      if let readError { Banner(text: readError, kind: .error) }
      if let status = bridge.fairStatus {
        Banner(text: status, kind: status.hasPrefix("Cortex") || status.hasPrefix("Import failed") ? .error : .note)
      }
    }
  }

  private func resultCard(_ imp: FairImport) -> some View {
    Card(title: imp.fairName.isEmpty ? "Companies" : imp.fairName, symbol: "list.bullet.rectangle") {
      HStack(spacing: 8) {
        Pill(imp.status == "enriching" ? "researching \(imp.done)/\(imp.total)" : imp.status,
             imp.status == "done" ? Theme.ok : imp.status == "failed" ? Theme.danger : Theme.warn)
        if imp.reloaded { Pill("glasses updated", Theme.ok) }
        if let n = imp.corpusSize { Pill("\(n) on file") }
      }
      ForEach(imp.companies) { c in
        HStack(spacing: 8) {
          Circle().fill(color(c.status)).frame(width: 8, height: 8)
          Text(c.name).font(.footnote).foregroundStyle(Theme.text).lineLimit(1)
          Spacer()
          Text(c.note ?? c.status).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
        }
      }
    }
  }

  private func color(_ status: String) -> Color {
    switch status {
    case "enriched", "matched": return Theme.ok
    case "failed": return Theme.danger
    default: return Theme.warn
    }
  }
}
