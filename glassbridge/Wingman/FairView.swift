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
  @State private var editing: BriefTarget?

  @State private var browsing = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 16) {
        briefsCard
        importCard
        if let imp = bridge.fairImport { resultCard(imp) }
      }
      .navigationDestination(isPresented: $browsing) { BriefsListView(editing: $editing) }
      .toolbar(.hidden, for: .navigationBar)
    }
    .task { await bridge.refreshFairImport(); await bridge.loadMyCompanies() }
    .sheet(item: $editing) { target in BriefEditor(target: target).environmentObject(bridge) }
  }

  // MARK: my briefs — the whole card is the tap target; the list lives on its own page so all of it scrolls

  private var briefsCard: some View {
    let all = bridge.myCompanies
    let complete = all.filter { BriefFill.isComplete($0.card) }.count
    let empty = all.filter { $0.card == nil }.count
    return Button { browsing = true } label: {
      Card(title: "Your briefs", symbol: "square.and.pencil") {
        Text("Rewrite what YOUR glasses show for any company. Only you see your version; everyone else keeps the shared brief.")
          .font(.footnote).foregroundStyle(Theme.muted)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 8) {
          Pill("\(complete) complete", Theme.ok)
          Pill("\(all.count - complete - empty) partial", Theme.warn)
          Pill("\(empty) empty", Theme.danger)
        }
        HStack {
          Text(all.isEmpty ? "No companies on file yet — import a fair list below." : "Browse all \(all.count) companies")
            .font(.footnote.weight(.bold)).foregroundStyle(Theme.accent)
          Spacer()
          Image(systemName: "chevron.right").font(.footnote.weight(.bold)).foregroundStyle(Theme.accent)
        }
        if let status = bridge.briefStatus { Banner(text: status, kind: status.hasPrefix("Cortex") ? .error : .note) }
      }
    }
    .buttonStyle(.plain)
    .disabled(!bridge.accountReady || all.isEmpty)
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
          if bridge.fairBusy { ProgressView().controlSize(.small).tint(.white) }
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

/// Sheet target: an existing row, or nil for a brand-new company (Cortex keys it by the name's slug).
struct BriefTarget: Identifiable {
  let company: MyCompany?
  var id: String { company?.companyId ?? "new" }
}

/// Edit one brief within the lens limits (C3): title 28, subtitle 48, 3–5 lines of 40. Counts are shown
/// live and Save is disabled while anything is over — Cortex rejects an over-limit card too.
struct BriefEditor: View {
  @EnvironmentObject private var bridge: BridgeController
  @Environment(\.dismiss) private var dismiss
  let target: BriefTarget
  @State private var name: String
  @State private var card: BriefCard

  init(target: BriefTarget) {
    self.target = target
    let c = target.company
    _name = State(initialValue: c?.name ?? "")
    var card = c?.card ?? BriefCard(title: c?.name ?? "", subtitle: "", lines: ["", "", ""])
    while card.lines.count < 3 { card.lines.append("") }
    _card = State(initialValue: card)
  }

  private var usedLines: [String] { card.lines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
  private var valid: Bool {
    !name.trimmingCharacters(in: .whitespaces).isEmpty
      && !card.title.isEmpty && card.title.count <= BriefCard.titleMax
      && card.subtitle.count <= BriefCard.subtitleMax
      && (3...5).contains(usedLines.count) && usedLines.allSatisfy { $0.count <= BriefCard.lineMax }
  }

  var body: some View {
    NavigationStack {
      ZStack {
        Theme.bg.ignoresSafeArea()
        ScrollView {
          VStack(spacing: 12) {
            if target.company == nil {
              limited("Company name", $name, max: 80)
            } else {
              Text(name).font(Theme.section).foregroundStyle(Theme.text).frame(maxWidth: .infinity, alignment: .leading)
            }
            limited("Title (on the lens)", $card.title, max: BriefCard.titleMax)
            limited("Subtitle — what they do", $card.subtitle, max: BriefCard.subtitleMax)
            ForEach(card.lines.indices, id: \.self) { i in
              limited("Bullet \(i + 1)", $card.lines[i], max: BriefCard.lineMax)
            }
            if card.lines.count < 5 {
              Button("Add a bullet") { card.lines.append("") }.buttonStyle(GhostButtonStyle())
            }
            Text("3 to 5 bullets, each a short sentence with a period. Blank bullets are dropped.")
              .font(.caption).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)

            Button {
              Task {
                var c = card; c.lines = usedLines
                if await bridge.saveBrief(companyId: target.company?.companyId, name: name.trimmingCharacters(in: .whitespaces), card: c) { dismiss() }
              }
            } label: {
              HStack(spacing: 8) {
                if bridge.briefBusy { ProgressView().controlSize(.small).tint(.white) }
                Text("Save my brief")
              }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(!valid || bridge.briefBusy)

            if let c = target.company, c.custom {
              Button("Reset to the shared brief") {
                Task { if await bridge.resetBrief(companyId: c.companyId) { dismiss() } }
              }
              .buttonStyle(PrimaryButtonStyle(color: Theme.danger))
              .disabled(bridge.briefBusy)
            }
            if let status = bridge.briefStatus, status.hasPrefix("Cortex") { Banner(text: status, kind: .error) }
          }
          .padding()
        }
      }
      .navigationTitle(target.company == nil ? "New brief" : "Your brief")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }
  }

  private func limited(_ label: String, _ text: Binding<String>, max: Int) -> some View {
    VStack(alignment: .trailing, spacing: 2) {
      TextField("", text: text, prompt: Text(label).foregroundColor(Theme.muted))
        .autocorrectionDisabled().font(.footnote).wingmanField()
      Text("\(text.wrappedValue.count)/\(max)")
        .font(.caption2).foregroundStyle(text.wrappedValue.count > max ? Theme.danger : Theme.muted)
    }
  }
}

/// Brief completeness: green = title, subtitle and all 5 bullets; yellow = a card with gaps; red = no card.
enum BriefFill {
  static func isComplete(_ card: BriefCard?) -> Bool {
    guard let card else { return false }
    return !card.title.isEmpty && !card.subtitle.isEmpty && card.lines.filter { !$0.isEmpty }.count >= 5
  }
  static func color(_ card: BriefCard?) -> Color {
    guard let card else { return Theme.danger }
    return isComplete(card) ? Theme.ok : Theme.warn
  }
  static func label(_ card: BriefCard?) -> String {
    guard let card else { return "empty" }
    return isComplete(card) ? "complete" : "\(card.lines.filter { !$0.isEmpty }.count)/5 bullets"
  }
}

/// The inner page: every company on file in a searchable, fully scrolling list. Tap a row to edit your brief;
/// the + button starts one for a company not on file.
struct BriefsListView: View {
  @EnvironmentObject private var bridge: BridgeController
  @Binding var editing: BriefTarget?
  @State private var query = ""

  private var filtered: [MyCompany] {
    let q = query.trimmingCharacters(in: .whitespaces)
    return q.isEmpty ? bridge.myCompanies : bridge.myCompanies.filter { $0.name.localizedCaseInsensitiveContains(q) }
  }

  var body: some View {
    List {
      Section {
        ForEach(filtered) { c in
          Button { editing = BriefTarget(company: c) } label: {
            HStack(spacing: 10) {
              Circle().fill(BriefFill.color(c.card)).frame(width: 9, height: 9)
              VStack(alignment: .leading, spacing: 2) {
                Text(c.name).font(.body).foregroundStyle(Theme.text).lineLimit(1)
                Text("\(c.custom ? "yours" : "shared") · \(BriefFill.label(c.card))").font(.caption).foregroundStyle(Theme.muted)
              }
              Spacer()
              Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.muted)
            }
          }
          .listRowBackground(Theme.surface)
        }
      } header: {
        HStack(spacing: 12) {
          legend(Theme.ok, "complete"); legend(Theme.warn, "partial"); legend(Theme.danger, "empty")
          Spacer()
          Text("\(filtered.count)").font(.caption2).foregroundStyle(Theme.muted)
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(Theme.bg)
    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search companies")
    .navigationTitle("Your briefs")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.visible, for: .navigationBar)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button { editing = BriefTarget(company: nil) } label: { Image(systemName: "plus") }
          .tint(Theme.accent)
      }
    }
    .refreshable { await bridge.loadMyCompanies() }
  }

  private func legend(_ color: Color, _ text: String) -> some View {
    HStack(spacing: 4) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(text).font(.caption2).foregroundStyle(Theme.muted)
    }
  }
}
