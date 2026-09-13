// WelcomeView.swift — the signed-out screen. Our own fields rather than Clerk's prebuilt sheet, so the
// first thing anyone sees is Wingman and not a generic login; AuthView is still one tap away under
// "Other options" for anything our two fields do not cover (passkeys, password, Apple).
//
// INTEGRATION: WelcomeView
// IN:  bridge.auth (isSignedIn / awaitingCode)
// OUT: AuthManager.signInWithEmail / verifyCode / signInWithGoogle
// WIRE: RootView shows this whenever clerk.user == nil

import SwiftUI
import ClerkKitUI

@MainActor
struct WelcomeView: View {
  @EnvironmentObject private var bridge: BridgeController
  @State private var email = ""
  @State private var code = ""
  @State private var busy = false
  @State private var error: String?
  @State private var showOtherOptions = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        Spacer(minLength: 40)
        VStack(alignment: .leading, spacing: 8) {
          Wordmark()
          Text("Your resume on your glasses. Sign in, drop in a PDF, and the lens does the rest.")
            .font(.callout)
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        }

        Card {
          if bridge.auth.awaitingCode { codeStep } else { emailStep }
          if let error { Banner(text: error, kind: .error) }
        }

        if !bridge.auth.awaitingCode {
          Button {
            run { try await bridge.auth.signInWithGoogle() }
          } label: {
            Label("Continue with Google", systemImage: "globe")
          }
          .buttonStyle(GhostButtonStyle())
          .disabled(busy)

          Text("No account yet? The same button makes one — we send a code either way.")
            .font(.caption)
            .foregroundStyle(Theme.muted)

          Button("Other options") { showOtherOptions = true }
            .font(.caption)
            .foregroundStyle(Theme.accent)
            .frame(maxWidth: .infinity)
        }
        Spacer(minLength: 24)
      }
      .padding(20)
    }
    // One AuthView at a time (ClerkKitUI's own hard rule) — this sheet is the only place it is mounted.
    .sheet(isPresented: $showOtherOptions) { AuthView() }
  }

  private var emailStep: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Email").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
      TextField("", text: $email, prompt: Text("you@school.edu").foregroundColor(Theme.muted))
        .textContentType(.emailAddress)
        .keyboardType(.emailAddress)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .wingmanField()
      Button {
        error = nil
        run { try await bridge.auth.signInWithEmail(email.trimmingCharacters(in: .whitespaces)) }
      } label: {
        busyLabel("Send code")
      }
      .buttonStyle(PrimaryButtonStyle())
      .disabled(busy || !email.contains("@"))
    }
  }

  private var codeStep: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Code sent to \(email)").font(.footnote).foregroundStyle(Theme.muted)
      TextField("", text: $code, prompt: Text("123456").foregroundColor(Theme.muted))
        .keyboardType(.numberPad)
        .textContentType(.oneTimeCode)
        .font(.title2.monospacedDigit())
        .wingmanField()
      Button {
        error = nil
        run { try await bridge.auth.verifyCode(code.trimmingCharacters(in: .whitespaces)) }
      } label: {
        busyLabel("Verify")
      }
      .buttonStyle(PrimaryButtonStyle())
      .disabled(busy || code.count < 6)

      Button("Use a different email") {
        code = ""
        error = nil
        bridge.auth.cancelCode()
      }
      .font(.caption)
      .foregroundStyle(Theme.accent)
    }
  }

  @ViewBuilder private func busyLabel(_ title: String) -> some View {
    HStack(spacing: 8) {
      if busy { ProgressView().controlSize(.small).tint(.white) }
      Text(busy ? "Working…" : title)
    }
  }

  /// Every button here is the same shape: disable, await, surface whatever Clerk said went wrong.
  private func run(_ work: @escaping () async throws -> Void) {
    busy = true
    Task {
      defer { busy = false }
      do { try await work() } catch { self.error = error.localizedDescription }
    }
  }
}
