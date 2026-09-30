import FileProvider
import Foundation

/// A refused API call, with the server's own message.
struct APIError: Error, LocalizedError {
  let method: String
  let status: Int
  let message: String
  let code: String?
  let currentVersion: Int?

  var errorDescription: String? { message }

  /// The server's "that name is taken" answers: a same-name 409 on create,
  /// rename or upload completion, or version_conflict from upload init.
  var isNameCollision: Bool {
    status == 409 && (code == "version_conflict" || message.localizedCaseInsensitiveContains("already exists"))
  }
}

/// Talks to the dosya.dev API with the extension's linked session. Refreshes
/// that session on a 401 (single-flight, and re-reading the keychain first in
/// case the app replaced it), and retries the failed call once.
actor APIClient {
  private let store: SessionStore
  private var session: LinkedSession?
  private var refreshing: Task<Void, Error>?
  private let urlSession: URLSession
  private var workspaceCache: (at: Date, list: [WorkspaceDTO])?
  /// Server clock minus device clock, from the last response's Date header.
  /// Change polls ask for rows updated after a SERVER timestamp, so a phone
  /// whose clock is off by more than the poll overlap would otherwise miss them.
  private var clockOffset: TimeInterval = 0

  /// The store and the transport are injected so tests can drive both without a
  /// keychain entitlement or a network.
  init(store: SessionStore, urlSession: URLSession) {
    self.store = store
    self.urlSession = urlSession
  }

  /// What the extension runs with. Process-wide on purpose: macOS hosts several
  /// instances of a replicated provider in one process, and two clients would
  /// mean two session caches and two refresh single-flights rotating one token
  /// against each other.
  static let live: APIClient = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 60
    config.waitsForConnectivity = false
    return APIClient(store: KeychainSessionStore(), urlSession: URLSession(configuration: config))
  }()

  // MARK: Session

  private func currentSession() throws -> LinkedSession {
    if let session { return session }
    guard let stored = store.load() else { throw notSignedIn() }
    session = stored
    return stored
  }

  private func notSignedIn() -> Error {
    NSFileProviderError(.notAuthenticated, userInfo: [
      NSLocalizedDescriptionKey: "Open the dosya.dev app to sign in.",
    ])
  }

  private func refresh(after failedAccess: String) async throws {
    if let running = refreshing {
      try await running.value
      return
    }
    let task = Task { try await self.performRefresh(after: failedAccess) }
    refreshing = task
    defer { refreshing = nil }
    try await task.value
  }

  private func performRefresh(after failedAccess: String) async throws {
    // The app may have minted a fresh session since this one was read.
    if let disk = store.load(), disk.access != failedAccess {
      session = disk
      return
    }
    let current = try currentSession()
    for attempt in 0..<2 {
      var request = URLRequest(url: try url(current, "/api/auth/mobile/refresh", query: [:]))
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": current.refresh])
      let (data, response) = try await urlSession.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      switch status {
      case 200..<300:
        let tokens = try JSONDecoder().decode(TokenResponse.self, from: data)
        let next = LinkedSession(access: tokens.access_token, refresh: tokens.refresh_token,
                                 apiBaseUrl: current.apiBaseUrl, userId: current.userId)
        store.save(next)
        session = next
        return
      case 401:
        // Rejected. Unless the app replaced the session meanwhile, it is dead:
        // clear it so the app mints a new one the next time it opens.
        if let disk = store.load(), disk.refresh != current.refresh {
          session = disk
          return
        }
        store.clear()
        session = nil
        throw notSignedIn()
      case 503 where attempt == 0:
        // The server is finishing a concurrent rotation of this same token.
        try await Task.sleep(nanoseconds: 2_000_000_000)
      default:
        throw NSFileProviderError(.serverUnreachable)
      }
    }
    throw NSFileProviderError(.serverUnreachable)
  }

  // MARK: Requests

  private func url(_ session: LinkedSession, _ path: String, query: [String: String?]) throws -> URL {
    let absolute = path.hasPrefix("http") ? path : session.apiBaseUrl + path
    guard var components = URLComponents(string: absolute) else { throw NSFileProviderError(.serverUnreachable) }
    let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
    if !items.isEmpty { components.queryItems = (components.queryItems ?? []) + items.sorted { $0.name < $1.name } }
    guard let url = components.url else { throw NSFileProviderError(.serverUnreachable) }
    return url
  }

  /// One authenticated call. `upload` sends a file from disk as the body without
  /// loading it into memory - the extension runs under a tight memory limit.
  func send(
    _ method: String,
    _ path: String,
    query: [String: String?] = [:],
    json: [String: Any]? = nil,
    body: Data? = nil,
    upload: URL? = nil,
    contentType: String? = nil
  ) async throws -> Data {
    var retried = false
    while true {
      let current = try currentSession()
      var request = URLRequest(url: try url(current, path, query: query))
      request.httpMethod = method
      request.setValue("Bearer \(current.access)", forHTTPHeaderField: "Authorization")
      if let json {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: json)
      } else if let contentType {
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
      }

      let data: Data
      let response: URLResponse
      do {
        if let upload {
          (data, response) = try await urlSession.upload(for: request, fromFile: upload)
        } else if let body {
          (data, response) = try await urlSession.upload(for: request, from: body)
        } else {
          (data, response) = try await urlSession.data(for: request)
        }
      } catch let error as URLError where error.code == .cancelled {
        throw CancellationError()
      } catch is URLError {
        throw NSFileProviderError(.serverUnreachable)
      }

      let http = response as? HTTPURLResponse
      let status = http?.statusCode ?? 0
      noteServerDate(http)
      if status == 401 && !retried {
        retried = true
        try await refresh(after: current.access)
        continue
      }
      if (200..<300).contains(status) { return data }
      let parsed = try? JSONDecoder().decode(ErrorBody.self, from: data)
      throw APIError(method: method, status: status, message: parsed?.error ?? "Request failed (\(status))",
                     code: parsed?.error_code ?? parsed?.error, currentVersion: parsed?.current_version)
    }
  }

  private func noteServerDate(_ response: HTTPURLResponse?) {
    guard let header = response?.value(forHTTPHeaderField: "Date") else { return }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "GMT")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    if let date = formatter.date(from: header) { clockOffset = date.timeIntervalSinceNow }
  }

  /// Now, on the server's clock (to the second).
  func serverNow() -> TimeInterval {
    Date().timeIntervalSince1970 + clockOffset
  }

  func get<T: Decodable>(_ type: T.Type, _ path: String, query: [String: String?] = [:]) async throws -> T {
    let data = try await send("GET", path, query: query)
    return try JSONDecoder().decode(T.self, from: data)
  }

  /// Presigned URLs carry their own authorization: fetched without the bearer.
  func download(_ remote: URL, to destination: URL) async throws {
    let (temp, response) = try await urlSession.download(from: remote)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      try? FileManager.default.removeItem(at: temp)
      throw status == 404 ? NSFileProviderError(.noSuchItem) : NSFileProviderError(.serverUnreachable)
    }
    try? FileManager.default.removeItem(at: destination)
    try FileManager.default.moveItem(at: temp, to: destination)
  }

  // MARK: Workspaces

  /// Workspaces the Files location shows: every membership except Vault ones.
  /// Cached briefly because item lookups for workspace roots are frequent.
  func workspaces(fresh: Bool = false) async throws -> [WorkspaceDTO] {
    if !fresh, let cache = workspaceCache, Date().timeIntervalSince(cache.at) < 60 { return cache.list }
    let visible = try await get(WorkspacesResponse.self, "/api/workspaces").workspaces
      .filter { ($0.e2ee_mode ?? 0) == 0 }
    let list = disambiguateWorkspaceNames(visible)
    workspaceCache = (Date(), list)
    return list
  }
}

/// Maps anything thrown while serving Finder onto the error domains the File
/// Provider framework understands, so it knows whether to retry, ask the user to
/// sign in, or give up on the item.
func providerError(_ error: Error) -> Error {
  if error is CancellationError { return CocoaError(.userCancelled) }
  let ns = error as NSError
  if ns.domain == NSFileProviderErrorDomain || ns.domain == NSCocoaErrorDomain { return error }
  guard let api = error as? APIError else { return NSFileProviderError(.serverUnreachable) }
  switch api.status {
  case 401: return NSFileProviderError(.notAuthenticated)
  case 403:
    let code: CocoaError.Code = api.method == "GET" ? .fileReadNoPermission : .fileWriteNoPermission
    return CocoaError(code, userInfo: [NSLocalizedDescriptionKey: api.message])
  case 404: return NSFileProviderError(.noSuchItem)
  case 409 where api.isNameCollision: return NSFileProviderError(.filenameCollision)
  case 429, 500...599: return NSFileProviderError(.serverUnreachable)
  default:
    if api.message.localizedCaseInsensitiveContains("storage") {
      return NSFileProviderError(.insufficientQuota)
    }
    return NSFileProviderError(.cannotSynchronize, userInfo: [NSLocalizedDescriptionKey: api.message])
  }
}
