// RootView.swift — the flow switch, and the only place that decides which screen you are on.
// Not signed in → WelcomeView. Signed in → a four-tab product (Profile · Glasses · Session · Feed) under a
// persistent bar carrying the account email, the link pill and the sign-out menu.
//
// INTEGRATION: RootView
// IN:  BridgeController (via @EnvironmentObject), including bridge.auth
// OUT: nothing — every action lives on BridgeController
// WIRE: App.swift → RootView().environmentObject(bridge)

import SwiftUI

@MainActor
struct RootView: View {
  @EnvironmentObject private var bridge: BridgeController

  var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      if !AuthManager.isAvailable {
        // No publishable key compiled in: say so instead of showing a sign-in that can never work.
        Card(title: "Sign-in unavailable", symbol: "exclamationmark.triangle") {
          Text("CLERK_PUBLISHABLE_KEY is empty in this build. Set it in Config.xcconfig and rebuild.")
            .font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding()
      } else if !bridge.auth.isLoaded {
        ProgressView().tint(Theme.accent)
      } else if !bridge.auth.isSignedIn {
        WelcomeView()
      } else {
        signedIn
      }
    }
    .preferredColorScheme(.dark)
  }

  private var signedIn: some View {
    VStack(spacing: 0) {
      topBar
      TabView {
        tab(ProfileView(), "Profile", "person.text.rectangle")
        tab(GlassesView(), "Glasses", "eyeglasses")
        tab(SessionView(), "Session", "play.circle")
        tab(FeedView(), "Feed", "waveform.path.ecg")
      }
      .tint(Theme.accent)
    }
    .task { await bridge.refreshProfile() }
  }

  private func tab<V: View>(_ view: V, _ title: String, _ symbol: String) -> some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      ScrollView { view.padding() }
    }
    .tabItem { Label(title, systemImage: symbol) }
  }

  // MARK: persistent bar

  private var topBar: some View {
    HStack(spacing: 10) {
      Wordmark(size: .system(.title3, design: .rounded).weight(.bold))
      Spacer(minLength: 8)
      Pill(linkLabel, linkColor)
      Menu {
        Text(bridge.auth.email ?? bridge.auth.displayName ?? "Signed in")
        Button("Refresh profile") { Task { await bridge.refreshProfile() } }
        if case .unlinked = bridge.linkState {
          Button("Link these glasses") { Task { await bridge.linkGlassesViaAccount() } }
        }
        Divider()
        Button("Sign out", role: .destructive) { Task { await bridge.signOut() } }
      } label: {
        Image(systemName: "person.crop.circle")
          .font(.title2)
          .foregroundStyle(Theme.accent)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(Theme.bg)
    .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 1) }
  }

  private var linkLabel: String {
    switch bridge.linkState {
    case .unlinked: return "Not linked"
    case .linked: return bridge.socketState == .connected ? "Linked" : "Linked · \(bridge.socketState)"
    }
  }

  private var linkColor: Color {
    switch bridge.linkState {
    case .unlinked: return Theme.warn
    case .linked: return bridge.socketState == .connected ? Theme.ok : Theme.warn
    }
  }
}
