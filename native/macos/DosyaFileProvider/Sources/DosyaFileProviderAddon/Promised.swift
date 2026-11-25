import CNodeAPI
import Foundation

/// Wrapping a completion-handler API as a JS promise.
///
/// A napi_deferred may only be settled on the JS thread, and the Apple APIs
/// this addon calls answer through completion handlers on queues of their own.
/// So each call is a napi_async_work: the execute callback runs on a libuv
/// worker and blocks there until the answer arrives, and the complete callback
/// settles the promise back on the JS thread. Blocking the worker is the
/// point; the JS thread stays free.
///
/// The worker is not parked forever: on `ceiling` it is released and the call
/// reports that macOS never answered. The pool has four threads by default,
/// and the main process shares it with every fs, dns and zlib call the app
/// makes. A JS caller that cannot wait that long races the promise in JS,
/// where the behaviour is testable.

/// The non-generic face of an in-flight call, which is what the C callbacks
/// below can hold: a napi callback is a plain C function pointer and cannot
/// capture a generic parameter, so the generic subclass is reached virtually.
class PromisedCallBase {
  var deferred: napi_deferred?
  var work: napi_async_work?
  let ceiling: DispatchTimeInterval

  init(ceiling: DispatchTimeInterval) {
    self.ceiling = ceiling
  }

  /// Starts the wrapped API; `done` is called once the outcome is recorded.
  func start(done: @escaping () -> Void) { done() }
  /// Records the ceiling expiring with nothing recorded yet.
  func timedOut() {}
  /// Settles the deferred from the recorded outcome. JS thread only.
  func settle(_ env: napi_env?) {}
}

/// One in-flight call: what to run, how to turn its answer into a JS value,
/// and the outcome the worker thread leaves for the JS thread to read.
///
/// The outcome is behind a lock and first-write-wins: once the ceiling has
/// expired, the real completion handler may still arrive, on its own queue,
/// while the JS thread is reading.
final class PromisedCall<Value>: PromisedCallBase {
  typealias Run = (@escaping (Result<Value, Error>) -> Void) -> Void
  typealias Encode = (napi_env?, Value) -> napi_value?

  private let run: Run
  private let encode: Encode
  private let lock = NSLock()
  private var settled: Result<Value, Error>?

  init(ceiling: DispatchTimeInterval, encode: @escaping Encode, run: @escaping Run) {
    self.run = run
    self.encode = encode
    super.init(ceiling: ceiling)
  }

  /// First writer wins. A late answer is dropped rather than racing the read.
  private func finish(_ result: Result<Value, Error>) {
    lock.lock()
    defer { lock.unlock() }
    if settled == nil { settled = result }
  }

  private var outcome: Result<Value, Error>? {
    lock.lock()
    defer { lock.unlock() }
    return settled
  }

  override func start(done: @escaping () -> Void) {
    run { result in
      self.finish(result)
      done()
    }
  }

  override func timedOut() {
    finish(.failure(PromisedTimeout()))
  }

  override func settle(_ env: napi_env?) {
    switch outcome {
    case .success(let value):
      napi_resolve_deferred(env, deferred, encode(env, value) ?? jsUndefined(env))
    case .failure(let error):
      napi_reject_deferred(env, deferred, jsError(env, error.localizedDescription))
    case nil:
      napi_reject_deferred(env, deferred, jsError(env, "the native call ended without an answer"))
    }
  }
}

struct PromisedTimeout: Error, LocalizedError {
  var errorDescription: String? { "the native call did not answer" }
}

/// A JS Error carrying `message`.
func jsError(_ env: napi_env?, _ message: String) -> napi_value? {
  var error: napi_value?
  napi_create_error(env, nil, jsString(env, message), &error)
  return error
}

/// Runs on a libuv worker thread. Blocking here is the point - the JS thread
/// stays free - but not forever.
private let executeWork: napi_async_execute_callback = { _, data in
  guard let data else { return }
  let call = Unmanaged<PromisedCallBase>.fromOpaque(data).takeUnretainedValue()
  let done = DispatchSemaphore(value: 0)
  call.start { done.signal() }
  if done.wait(timeout: .now() + call.ceiling) == .timedOut {
    call.timedOut()
  }
}

/// Runs on the JS thread, the only place a deferred may be settled.
private let completeWork: napi_async_complete_callback = { env, _, data in
  guard let data else { return }
  let call = Unmanaged<PromisedCallBase>.fromOpaque(data).takeRetainedValue()
  call.settle(env)
  if let work = call.work { napi_delete_async_work(env, work) }
}

/// Wraps a completion-handler API as a JS promise. `encode` turns the answer
/// into a JS value on the JS thread; `run` starts the API and must call its
/// continuation exactly once, from any thread.
func promised<Value>(
  _ env: napi_env?,
  _ name: String,
  ceiling: DispatchTimeInterval,
  encode: @escaping PromisedCall<Value>.Encode,
  run: @escaping PromisedCall<Value>.Run
) -> napi_value? {
  let call = PromisedCall(ceiling: ceiling, encode: encode, run: run)
  var promise: napi_value?
  guard napi_create_promise(env, &call.deferred, &promise) == napi_ok else {
    return throwError(env, "\(name) could not create its promise")
  }

  var resourceName: napi_value?
  napi_create_string_utf8(env, name, autoLength, &resourceName)
  // Retained for napi to hold; completeWork takes the reference back.
  let context = Unmanaged<PromisedCallBase>.passRetained(call).toOpaque()
  guard napi_create_async_work(env, nil, resourceName, executeWork, completeWork, context, &call.work) == napi_ok,
        napi_queue_async_work(env, call.work) == napi_ok
  else {
    // Reject the promise rather than orphan it: it was already handed to JS by
    // napi_create_promise, and a caller awaiting a promise nobody will ever
    // settle is worse than one that fails.
    if let work = call.work { napi_delete_async_work(env, work) }
    napi_reject_deferred(env, call.deferred, jsError(env, "\(name) could not be scheduled"))
    Unmanaged<PromisedCallBase>.fromOpaque(context).release()
    return promise
  }
  return promise
}

/// An already-settled promise, for a macOS too old to have the API at all. The
/// caller gets a promise either way, so nothing has to branch on the version.
func jsResolved(_ env: napi_env?, _ value: napi_value?) -> napi_value? {
  var deferred: napi_deferred?
  var promise: napi_value?
  guard napi_create_promise(env, &deferred, &promise) == napi_ok else { return nil }
  napi_resolve_deferred(env, deferred, value)
  return promise
}
