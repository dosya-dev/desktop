import AppKit
import AuthenticationServices
import CNodeAPI
import Foundation
import Security

/// Sign in with Apple, in the app.
///
/// App Review (guideline 4, 2026-11-11) refused the desktop app for sending
/// "Continue with Apple" to the system browser: Apple's own provider has to be
/// completed without leaving the app, which on macOS means the
/// AuthenticationServices sheet. Electron cannot show that sheet, so it lives
/// here, in the addon the main process already loads for the Finder location.
///
/// What JS gets back is exactly what Apple handed the app - the identity token,
/// the authorization code, and the name on a first authorization - and the
/// server does the verifying. The nonce is the one thing the app adds: JS
/// makes a secret, passes its SHA-256 here, and Apple echoes that hash inside
/// the signed token, so the server can check the token answers THIS request.

enum AppleSignInConstants {
  /// The entitlement the sheet requires. Without it the controller fails with
  /// an "unknown" error after a visible flash, so availability is read from
  /// the process's own entitlements first and JS falls back to the browser
  /// flow on a build (a dev run, the direct download) that lacks it.
  static let entitlement = "com.apple.developer.applesignin"
  /// Apple's sheet can involve a password, a second factor on another device
  /// and a choice about hiding the email; none of that should race a clock.
  static let ceiling: DispatchTimeInterval = .seconds(15 * 60)
  /// Error messages JS matches on exactly. Everything else is a failure with
  /// a code for the log.
  static let canceled = "canceled"
  static let unavailable = "unavailable"
  static let busy = "busy"
}

/// Whether this process's code signature carries `key`. An array entitlement
/// (which applesignin is: `["Default"]`) counts when non-empty; a boolean
/// counts when true.
func processHasEntitlement(_ key: String) -> Bool {
  guard let task = SecTaskCreateFromSelf(nil) else { return false }
  var error: Unmanaged<CFError>?
  guard let value = SecTaskCopyValueForEntitlement(task, key as CFString, &error) else { return false }
  if let array = value as? [Any] { return !array.isEmpty }
  if let flag = value as? Bool { return flag }
  return true
}

let appleSignInAvailableCallback: napi_callback = { env, _ in
  jsBool(env, processHasEntitlement(AppleSignInConstants.entitlement))
}

/// What Apple handed back. Strings are empty rather than absent so the JS
/// object always has the same shape; `name` and `email` are only ever filled
/// on the FIRST authorization for an Apple ID, by Apple's design.
struct AppleCredential {
  let identityToken: String
  let authorizationCode: String
  let user: String
  let name: String
  let email: String

  func fields() -> [(String, String)] {
    [
      ("identityToken", identityToken),
      ("authorizationCode", authorizationCode),
      ("user", user),
      ("name", name),
      ("email", email),
    ]
  }
}

struct AppleSignInFailure: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// One presentation of the sheet. Kept alive by `current` until Apple answers:
/// the controller holds its delegate weakly, and nothing else references this
/// object while the sheet is up.
final class AppleSignInSession: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  /// The sheet in progress, if any. Main thread only.
  static var current: AppleSignInSession?

  private let finish: (Result<AppleCredential, Error>) -> Void
  private var controller: ASAuthorizationController?

  init(finish: @escaping (Result<AppleCredential, Error>) -> Void) {
    self.finish = finish
  }

  /// Main thread only. Builds the request and presents the sheet.
  func begin(nonceHash: String) {
    let provider = ASAuthorizationAppleIDProvider()
    let request = provider.createRequest()
    request.requestedScopes = [.fullName, .email]
    request.nonce = nonceHash
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    self.controller = controller
    controller.performRequests()
  }

  /// The window the sheet attaches to: whichever of the app's windows the user
  /// is looking at. Electron's BrowserWindow is an NSWindow like any other.
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    let app = NSApplication.shared
    if let window = app.keyWindow ?? app.mainWindow { return window }
    if let visible = app.windows.first(where: { $0.isVisible }) { return visible }
    // Nothing on screen: a detached window still lets the sheet appear rather
    // than crashing on a nil anchor. Reached only if the renderer managed to
    // ask with its own window gone.
    return NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: false)
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    defer { AppleSignInSession.current = nil }
    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
      finish(.failure(AppleSignInFailure(message: "Apple returned a credential of an unexpected kind")))
      return
    }
    let token = credential.identityToken.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    guard !token.isEmpty else {
      finish(.failure(AppleSignInFailure(message: "Apple returned no identity token")))
      return
    }
    let code = credential.authorizationCode.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    let name = credential.fullName.map { PersonNameComponentsFormatter().string(from: $0) } ?? ""
    finish(.success(AppleCredential(
      identityToken: token,
      authorizationCode: code,
      user: credential.user,
      name: name.trimmingCharacters(in: .whitespacesAndNewlines),
      email: credential.email ?? ""
    )))
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    defer { AppleSignInSession.current = nil }
    let nsError = error as NSError
    if nsError.domain == ASAuthorizationErrorDomain {
      switch ASAuthorizationError.Code(rawValue: nsError.code) {
      case .canceled:
        finish(.failure(AppleSignInFailure(message: AppleSignInConstants.canceled)))
        return
      case .unknown:
        // What a missing entitlement, or an Apple ID not signed into this Mac,
        // looks like. JS treats it as "use the browser instead".
        finish(.failure(AppleSignInFailure(message: AppleSignInConstants.unavailable)))
        return
      default:
        break
      }
    }
    finish(.failure(AppleSignInFailure(message: "Sign in with Apple failed (\(nsError.domain) \(nsError.code))")))
  }
}

/// `signInWithApple(nonceHash)`: presents the sheet and resolves to the
/// credential, or rejects with "canceled", "unavailable", "busy", or a
/// described failure.
let signInWithAppleCallback: napi_callback = { env, info in
  guard let nonceHash = swiftString(env, arguments(env, info, count: 1).first ?? nil), !nonceHash.isEmpty else {
    return throwError(env, "signInWithApple needs the SHA-256 of the nonce as a string")
  }
  let encode: PromisedCall<AppleCredential>.Encode = { env, credential in jsObject(env, credential.fields()) }
  guard processHasEntitlement(AppleSignInConstants.entitlement) else {
    return promised(env, "signInWithApple", ceiling: .seconds(1), encode: encode) { finish in
      finish(.failure(AppleSignInFailure(message: AppleSignInConstants.unavailable)))
    }
  }
  return promised(env, "signInWithApple", ceiling: AppleSignInConstants.ceiling, encode: encode) { finish in
    // The sheet is UI: built and presented on the main thread, whatever
    // thread the worker that called us is on.
    DispatchQueue.main.async {
      if AppleSignInSession.current != nil {
        finish(.failure(AppleSignInFailure(message: AppleSignInConstants.busy)))
        return
      }
      let session = AppleSignInSession(finish: finish)
      AppleSignInSession.current = session
      session.begin(nonceHash: nonceHash)
    }
  }
}
