import CNodeAPI
import FileProvider
import Foundation

/// Adding and removing the Finder location. Only the extension's containing app
/// may do this, which is this process.
///
/// Each call is a completion-handler API wrapped as a JS promise; the plumbing
/// is in Promised.swift.

/// How long a worker thread may stay parked waiting for macOS. The JS side gives
/// up sooner (see file-provider.ts), so this ceiling is never what a user waits
/// for; it exists so a `fileproviderd` that never answers cannot keep a libuv
/// worker for the life of the process.
private let workerCeiling: DispatchTimeInterval = .seconds(90)

/// A domain call's answer as JS: a boolean, or null for "the thing asked about
/// does not exist", which for a domain query is different from "not approved".
private func encodeDomainAnswer(_ env: napi_env?, _ value: Bool?) -> napi_value? {
  value.map { jsBool(env, $0) } ?? jsNull(env)
}

/// Wraps a File Provider completion-handler API as a JS promise.
private func promised(
  _ env: napi_env?,
  _ name: String,
  _ run: @escaping (@escaping (Result<Bool?, Error>) -> Void) -> Void
) -> napi_value? {
  promised(env, name, ceiling: workerCeiling, encode: encodeDomainAnswer, run: run)
}

/// An already-resolved `false`, for a macOS too old to have the API at all.
private func jsResolvedFalse(_ env: napi_env?) -> napi_value? {
  jsResolved(env, jsBool(env, false))
}

/// The domain this app offers Finder. Built fresh each time: it is a value, and
/// NSFileProviderManager matches it by identifier.
@available(macOS 12.0, *)
private func domain() -> NSFileProviderDomain {
  NSFileProviderDomain(
    identifier: NSFileProviderDomainIdentifier(DomainConstants.identifier),
    displayName: DomainConstants.displayName
  )
}

let registerDomainCallback: napi_callback = { env, _ in
  guard #available(macOS 12.0, *) else { return jsResolvedFalse(env) }
  return promised(env, "registerDomain") { finish in
    NSFileProviderManager.add(domain()) { error in
      if let error { finish(.failure(error)) } else { finish(.success(true)) }
    }
  }
}

/// Removing the domain also deletes every file macOS downloaded for it, which is
/// what sign-out and an account switch need: the next account must not find the
/// previous one's files under Locations.
let removeDomainCallback: napi_callback = { env, _ in
  guard #available(macOS 12.0, *) else { return jsResolvedFalse(env) }
  return promised(env, "removeDomain") { finish in
    NSFileProviderManager.remove(domain()) { error in
      // "No such domain" is the resting state of a signed-out Mac, and removing
      // what is not there is exactly what the caller asked for.
      if let error = error as NSError?, error.domain != NSFileProviderErrorDomain {
        finish(.failure(error))
      } else {
        finish(.success(true))
      }
    }
  }
}

/// Asks macOS to poll the working set now, so Finder does not wait for its own
/// schedule after the app changed something.
let signalChangesCallback: napi_callback = { env, _ in
  guard #available(macOS 12.0, *) else { return jsResolvedFalse(env) }
  return promised(env, "signalChanges") { finish in
    guard let manager = NSFileProviderManager(for: domain()) else {
      finish(.success(false))
      return
    }
    manager.signalEnumerator(for: .workingSet) { _ in finish(.success(true)) }
  }
}

/// Whether the user has approved this provider, or null when no domain is
/// registered at all.
///
/// macOS adds a domain in a DISABLED state and keeps it there until the user
/// approves the extension in System Settings (General > Login Items &
/// Extensions > File Providers). Until then the folder exists under
/// ~/Library/CloudStorage and every request against it fails with "Sync is not
/// enabled", so Finder just hangs. Nothing the app can do grants that approval:
/// `pluginkit -e use` does not move it, and Apple's own
/// NSExtensionFileProviderEnabledByDefault is ignored for third-party apps
/// (both measured 2026-09-30). All the app can do is notice and say so.
let domainEnabledCallback: napi_callback = { env, _ in
  guard #available(macOS 12.0, *) else { return jsResolvedNull(env) }
  return promised(env, "domainEnabled") { finish in
    NSFileProviderManager.getDomainsWithCompletionHandler { domains, error in
      if let error {
        finish(.failure(error))
        return
      }
      guard let ours = domains.first(where: { $0.identifier.rawValue == DomainConstants.identifier }) else {
        finish(.success(nil))
        return
      }
      finish(.success(ours.userEnabled))
    }
  }
}

/// An already-resolved null, for a macOS too old to have the API.
private func jsResolvedNull(_ env: napi_env?) -> napi_value? {
  jsResolved(env, jsNull(env))
}
