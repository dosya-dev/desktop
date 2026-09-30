import CNodeAPI
import FileProvider
import Foundation

/// Adding and removing the Finder location. Only the extension's containing app
/// may do this, which is this process.
///
/// The Apple calls answer through a completion handler, and a napi_deferred may
/// only be settled on the JS thread, so each call is a napi_async_work: the
/// execute callback runs on a libuv worker and blocks there until the answer
/// arrives, and the complete callback settles the promise back on the JS thread.
/// Blocking the worker is the point; the JS thread stays free.
///
/// There is deliberately no timeout here. macOS takes as long as it takes, and a
/// caller that cannot wait races the promise in JS, where the behaviour is
/// testable.

/// How long a worker thread may stay parked waiting for macOS. The JS side gives
/// up sooner (see file-provider.ts), so this ceiling is never what a user waits
/// for; it exists so a `fileproviderd` that never answers cannot keep a libuv
/// worker for the life of the process. The pool has four threads by default, and
/// the main process shares it with every fs, dns and zlib call the app makes.
private let workerCeiling: DispatchTimeInterval = .seconds(90)

/// One in-flight call: what to run, the promise to settle, the work handle to
/// free, and the outcome the worker thread leaves for the JS thread to read.
///
/// A class, retained through an opaque pointer napi holds, because the two
/// callbacks run on different threads and neither owns the other. The outcome is
/// behind a lock and first-write-wins: once the ceiling above has expired, the
/// real completion handler may still arrive, on its own queue, while the JS
/// thread is reading.
private final class DomainCall {
  let run: (@escaping (Result<Bool?, Error>) -> Void) -> Void
  var deferred: napi_deferred?
  var work: napi_async_work?

  private let lock = NSLock()
  private var settled: Result<Bool?, Error>?

  init(run: @escaping (@escaping (Result<Bool?, Error>) -> Void) -> Void) {
    self.run = run
  }

  /// First writer wins. A late answer is dropped rather than racing the read.
  func finish(_ result: Result<Bool?, Error>) {
    lock.lock()
    defer { lock.unlock() }
    if settled == nil { settled = result }
  }

  var outcome: Result<Bool?, Error>? {
    lock.lock()
    defer { lock.unlock() }
    return settled
  }
}

/// Runs on a libuv worker thread. Blocking here is the point - the JS thread
/// stays free - but not forever: on expiry the worker is released and the call
/// reports that macOS never answered.
private let executeWork: napi_async_execute_callback = { _, data in
  guard let data else { return }
  let call = Unmanaged<DomainCall>.fromOpaque(data).takeUnretainedValue()
  let done = DispatchSemaphore(value: 0)
  call.run { result in
    call.finish(result)
    done.signal()
  }
  if done.wait(timeout: .now() + workerCeiling) == .timedOut {
    call.finish(.failure(FileProviderTimeout()))
  }
}

private struct FileProviderTimeout: Error, LocalizedError {
  var errorDescription: String? { "the File Provider call did not answer" }
}

/// Runs on the JS thread, the only place a deferred may be settled.
private let completeWork: napi_async_complete_callback = { env, _, data in
  guard let data else { return }
  let call = Unmanaged<DomainCall>.fromOpaque(data).takeRetainedValue()
  switch call.outcome {
  case .success(let value):
    // nil is a real answer, not a failure: it means the thing asked about does
    // not exist, which for a domain query is different from "not approved".
    napi_resolve_deferred(env, call.deferred, value.map { jsBool(env, $0) } ?? jsNull(env))
  case .failure(let error):
    var rejection: napi_value?
    napi_create_error(env, nil, jsString(env, error.localizedDescription), &rejection)
    napi_reject_deferred(env, call.deferred, rejection)
  case nil:
    var rejection: napi_value?
    napi_create_error(env, nil, jsString(env, "the File Provider call ended without an answer"), &rejection)
    napi_reject_deferred(env, call.deferred, rejection)
  }
  if let work = call.work { napi_delete_async_work(env, work) }
}

/// Wraps a completion-handler API as a JS promise.
private func promised(
  _ env: napi_env?,
  _ name: String,
  _ run: @escaping (@escaping (Result<Bool?, Error>) -> Void) -> Void
) -> napi_value? {
  let call = DomainCall(run: run)
  var promise: napi_value?
  guard napi_create_promise(env, &call.deferred, &promise) == napi_ok else {
    return throwError(env, "\(name) could not create its promise")
  }

  var resourceName: napi_value?
  napi_create_string_utf8(env, name, autoLength, &resourceName)
  // Retained for napi to hold; completeWork takes the reference back.
  let context = Unmanaged.passRetained(call).toOpaque()
  guard napi_create_async_work(env, nil, resourceName, executeWork, completeWork, context, &call.work) == napi_ok,
        napi_queue_async_work(env, call.work) == napi_ok
  else {
    // Reject the promise rather than orphan it: it was already handed to JS by
    // napi_create_promise, and a caller awaiting a promise nobody will ever
    // settle is worse than one that fails.
    if let work = call.work { napi_delete_async_work(env, work) }
    var rejection: napi_value?
    napi_create_error(env, nil, jsString(env, "\(name) could not be scheduled"), &rejection)
    napi_reject_deferred(env, call.deferred, rejection)
    Unmanaged<DomainCall>.fromOpaque(context).release()
    return promise
  }
  return promise
}

/// An already-resolved `false`, for a macOS too old to have the API at all. The
/// caller gets a promise either way, so nothing has to branch on the version.
private func jsResolvedFalse(_ env: napi_env?) -> napi_value? {
  var deferred: napi_deferred?
  var promise: napi_value?
  guard napi_create_promise(env, &deferred, &promise) == napi_ok else { return nil }
  napi_resolve_deferred(env, deferred, jsBool(env, false))
  return promise
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
  var deferred: napi_deferred?
  var promise: napi_value?
  guard napi_create_promise(env, &deferred, &promise) == napi_ok else { return nil }
  napi_resolve_deferred(env, deferred, jsNull(env))
  return promise
}
