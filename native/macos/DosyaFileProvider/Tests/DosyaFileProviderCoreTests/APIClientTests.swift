import FileProvider
import XCTest
@testable import DosyaFileProviderCore

final class APIClientTests: XCTestCase {
  private func make(_ session: LinkedSession? = LinkedSession(
    access: "acc1", refresh: "ref1", apiBaseUrl: "https://api.test", userId: "u1"
  )) -> (APIClient, MemorySessionStore) {
    let store = MemorySessionStore(session)
    return (APIClient(store: store, urlSession: StubURLProtocol.session()), store)
  }

  override func setUp() {
    super.setUp()
    StubURLProtocol.reset()
  }

  func testSendsTheBearer() async throws {
    let (api, _) = make()
    StubURLProtocol.handler = { StubURLProtocol.ok($0, #"{"ok":true}"#) }
    _ = try await api.send("GET", "/api/workspaces")
    XCTAssertEqual(StubURLProtocol.recorded.first?.request.value(forHTTPHeaderField: "Authorization"), "Bearer acc1")
    XCTAssertEqual(StubURLProtocol.recorded.first?.request.url?.absoluteString, "https://api.test/api/workspaces")
  }

  func testRefreshesOnceOn401ThenRetries() async throws {
    let (api, store) = make()
    StubURLProtocol.handler = { request in
      if request.url!.path == "/api/auth/mobile/refresh" {
        return StubURLProtocol.ok(request, #"{"access_token":"acc2","refresh_token":"ref2"}"#)
      }
      let first = StubURLProtocol.recorded.count <= 1
      return StubURLProtocol.ok(request, first ? #"{"error":"expired"}"# : #"{"ok":true}"#, status: first ? 401 : 200)
    }
    _ = try await api.send("GET", "/api/workspaces")
    XCTAssertEqual(store.load()?.access, "acc2")
    XCTAssertEqual(StubURLProtocol.recorded.count, 3)
    XCTAssertEqual(StubURLProtocol.recorded.last?.request.value(forHTTPHeaderField: "Authorization"), "Bearer acc2")
  }

  func testARefreshedCallThatIsRefusedAgainDoesNotLoop() async {
    // The one shape an infinite loop would take: refresh works, the retry is
    // still refused. It must surface, not spin.
    let (api, _) = make()
    StubURLProtocol.handler = { request in
      if request.url!.path == "/api/auth/mobile/refresh" {
        return StubURLProtocol.ok(request, #"{"access_token":"acc2","refresh_token":"ref2"}"#)
      }
      return StubURLProtocol.ok(request, #"{"error":"still no"}"#, status: 401)
    }
    do {
      _ = try await api.send("GET", "/api/workspaces")
      XCTFail("expected the second refusal to surface")
    } catch let error as APIError {
      XCTAssertEqual(error.status, 401)
    } catch {
      XCTFail("unexpected \(error)")
    }
    XCTAssertEqual(StubURLProtocol.recorded.count, 3, "one call, one refresh, one retry and no more")
  }

  func testTheServerClockDrivesChangePolls() async throws {
    // Change polls ask for rows updated after a SERVER timestamp. A Mac whose
    // clock is behind would otherwise ask for a window that has already passed
    // and never see the change.
    let (api, _) = make()
    let serverNow = Date().addingTimeInterval(3600)
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "GMT")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    StubURLProtocol.handler = { request in
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["Date": formatter.string(from: serverNow)]
      )!
      return (response, Data(#"{"ok":true}"#.utf8))
    }
    _ = try await api.send("GET", "/api/workspaces")
    let drift = await api.serverNow() - Date().timeIntervalSince1970
    XCTAssertEqual(drift, 3600, accuracy: 5, "the client should follow the server's clock")
  }

  func testARejectedRefreshClearsTheSession() async {
    let (api, store) = make()
    StubURLProtocol.handler = { StubURLProtocol.ok($0, "", status: 401) }
    do {
      _ = try await api.send("GET", "/api/workspaces")
      XCTFail("expected a not-signed-in error")
    } catch {
      XCTAssertEqual((error as NSError).code, NSFileProviderError.notAuthenticated.rawValue)
    }
    XCTAssertNil(store.load(), "a dead session must not be left for the next launch to reuse")
    XCTAssertEqual(store.clears, 1, "cleared exactly once")
  }

  func testNoSessionMeansNotSignedInWithoutARequest() async {
    let (api, _) = make(nil)
    do {
      _ = try await api.send("GET", "/api/workspaces")
      XCTFail("expected a not-signed-in error")
    } catch {
      XCTAssertEqual((error as NSError).code, NSFileProviderError.notAuthenticated.rawValue)
    }
    XCTAssertTrue(StubURLProtocol.recorded.isEmpty)
  }

  func testRefusedCallsCarryTheServerMessage() async {
    let (api, _) = make()
    StubURLProtocol.handler = { StubURLProtocol.ok($0, #"{"error":"A file named a.txt already exists"}"#, status: 409) }
    do {
      _ = try await api.send("POST", "/api/folders")
      XCTFail("expected an APIError")
    } catch let error as APIError {
      XCTAssertEqual(error.status, 409)
      XCTAssertTrue(error.isNameCollision)
    } catch {
      XCTFail("unexpected \(error)")
    }
  }

  func testHidesVaultWorkspacesAndCachesTheList() async throws {
    let (api, _) = make()
    StubURLProtocol.handler = {
      StubURLProtocol.ok($0, #"{"workspaces":[{"id":"w1","name":"A"},{"id":"w2","name":"V","e2ee_mode":1}]}"#)
    }
    let first = try await api.workspaces()
    XCTAssertEqual(first.map(\.id), ["w1"], "a Vault workspace must never reach Finder")
    _ = try await api.workspaces()
    XCTAssertEqual(StubURLProtocol.recorded.count, 1, "the second call should come from the cache")
  }

  func testAbsoluteURLsAreUsedAsGiven() async throws {
    let (api, _) = make()
    StubURLProtocol.handler = { StubURLProtocol.ok($0, "{}") }
    _ = try await api.send("PUT", "https://storage.test/presigned/1")
    XCTAssertEqual(StubURLProtocol.recorded.first?.request.url?.absoluteString, "https://storage.test/presigned/1")
  }

  func testDownloadsWithoutTheBearerAndLandsTheBytes() async throws {
    let (api, _) = make()
    StubURLProtocol.handler = { StubURLProtocol.ok($0, "hello finder") }
    let destination = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("dosya-download-\(UUID().uuidString)")
    try await api.download(URL(string: "https://storage.test/blob")!, to: destination)
    XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "hello finder")
    XCTAssertNil(StubURLProtocol.recorded.first?.request.value(forHTTPHeaderField: "Authorization"),
                 "a presigned URL carries its own authorization")
    try? FileManager.default.removeItem(at: destination)
  }
}
