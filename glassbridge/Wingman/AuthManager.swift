// AuthManager.swift — Clerk, wrapped in exactly as much as the UI needs. Clerk is @Observable and
// SwiftUI-native on its own; this exists only because BridgeController is an ObservableObject and the
// rest of the app already speaks @Published.
//
// INTEGRATION(X-MACHINE):
// COUNTERPART: cortex/src/rest/routes.ts createClerkVerifier — the JWT `token()` returns is what
//   `Authorization: Bearer` carries, and Cortex maps its `sub` to our userId.
// CONTRACT: same Clerk instance on both sides. iOS ships the PUBLISHABLE key (public by design);
//   Cortex holds CLERK_SECRET_KEY. Frontend API host: engaged-pegasus-5798.clerk.accounts.dev.
// AT-INTEGRATION: sign in on the phone, then hit any authenticated route — a 401 here means the two
//   sides are pointed at different Clerk instances, not that the user typed the code wrong.
//
// INTEGRATION: AuthManager
// IN:  email + 6-digit code, or Google OAuth, from WelcomeView
// OUT: isLoaded / isSignedIn / displayName / email for the UI; token() for CortexClient
// WIRE: owned by BridgeController (`let auth`); Clerk.configure runs once in App.init.

import Foundation
import SwiftUI
import ClerkKit

@MainActor
final class AuthManager: ObservableObject {
  enum AuthError: Error, LocalizedError {
    case unavailable
    case notSignedIn
    case noPendingCode

    var errorDescription: String? {
      switch self {
      case .unavailable: return "Sign-in unavailable — CLERK_PUBLISHABLE_KEY is not set in this build."
      case .notSignedIn: return "Not signed in."
      case .noPendingCode: return "Ask for a code first."
      }
    }
  }

  /// Empty key = this build has no Clerk. Every call then fails politely instead of tripping the
  /// assertionFailure that `Clerk.shared` raises before `configure`.
  static var isAvailable: Bool { !Config.clerkPublishableKey.isEmpty }

  @Published private(set) var isLoaded = false
  @Published private(set) var isSignedIn = false
  @Published private(set) var displayName: String?
  @Published private(set) var email: String?
  /// A code is out; the UI shows the six-digit field.
  @Published private(set) var awaitingCode = false

  /// SignIn/SignUp are STRUCTS — each step returns a new value and must be stored back (research §3).
  private var pendingSignIn: SignIn?
  private var pendingSignUp: SignUp?

  init() {
    guard Self.isAvailable else { return }
    sync()
    track()
  }

  // MARK: email code (sign in, falling through to sign up)

  func signInWithEmail(_ address: String) async throws {
    guard Self.isAvailable else { throw AuthError.unavailable }
    pendingSignUp = nil
    do {
      pendingSignIn = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: address)
      awaitingCode = true
    } catch {
      // "No account for that address" is the demo's most likely first answer, and making the user
      // find a second button for it is silly — try a sign-up, and only report the original failure
      // if that fails too (a network error must not be reported as a sign-up problem).
      let signInFailure = error
      do { try await signUpWithEmail(address) } catch { throw signInFailure }
    }
  }

  func signUpWithEmail(_ address: String) async throws {
    guard Self.isAvailable else { throw AuthError.unavailable }
    pendingSignIn = nil
    var signUp = try await Clerk.shared.auth.signUp(emailAddress: address)
    signUp = try await signUp.sendEmailCode()
    pendingSignUp = signUp
    awaitingCode = true
  }

  func verifyCode(_ code: String) async throws {
    guard Self.isAvailable else { throw AuthError.unavailable }
    if var signUp = pendingSignUp {
      signUp = try await signUp.verifyEmailCode(code)
      pendingSignUp = signUp
    } else if var signIn = pendingSignIn {
      signIn = try await signIn.verifyCode(code)
      pendingSignIn = signIn
    } else {
      throw AuthError.noPendingCode
    }
    sync()
  }

  /// "Wrong address" — back to the email field.
  func cancelCode() {
    pendingSignIn = nil
    pendingSignUp = nil
    awaitingCode = false
  }

  // MARK: OAuth / sign out / token

  func signInWithGoogle() async throws {
    guard Self.isAvailable else { throw AuthError.unavailable }
    _ = try await Clerk.shared.auth.signInWithOAuth(provider: .google)
    sync()
  }

  func signOut() async {
    guard Self.isAvailable else { return }
    try? await Clerk.shared.auth.signOut(sessionId: nil)
    cancelCode()
    sync()
  }

  /// Called immediately before every Cortex request — Clerk caches (1-minute TTL) so this is cheap.
  func token() async throws -> String {
    guard Self.isAvailable else { throw AuthError.unavailable }
    guard let token = try await Clerk.shared.auth.getToken() else { throw AuthError.notSignedIn }
    return token
  }

  // MARK: @Observable → ObservableObject bridge

  private func sync() {
    let clerk = Clerk.shared
    isLoaded = clerk.isLoaded
    let user = clerk.user
    isSignedIn = user != nil
    email = user?.primaryEmailAddress?.emailAddress
    displayName = user.map { u in
      let full = [u.firstName, u.lastName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
      if !full.isEmpty { return full }
      return u.username ?? u.primaryEmailAddress?.emailAddress ?? "Signed in"
    }
    if user != nil { pendingSignIn = nil; pendingSignUp = nil; awaitingCode = false }
  }

  /// One-shot by design: re-register after every change (Observation has no "keep watching" mode).
  private func track() {
    let clerk = Clerk.shared
    withObservationTracking {
      _ = clerk.isLoaded
      _ = clerk.user?.id
    } onChange: { [weak self] in
      // onChange fires BEFORE the new value lands — hop so `sync` reads the settled state.
      Task { @MainActor in
        self?.sync()
        self?.track()
      }
    }
  }
}

/// `.environment(Clerk.shared)` would trip Clerk's own assertion when the key is missing, so the
/// injection ClerkKitUI's AuthView needs is conditional. ponytail: a ViewModifier is the only way
/// SwiftUI lets you skip a modifier without boxing the view in AnyView.
struct ClerkEnvironment: ViewModifier {
  func body(content: Content) -> some View {
    if AuthManager.isAvailable {
      content.environment(Clerk.shared)
    } else {
      content
    }
  }
}
