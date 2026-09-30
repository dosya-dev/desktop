import FileProvider
import XCTest
@testable import DosyaFileProviderCore

final class ErrorMappingTests: XCTestCase {
  private func api(_ status: Int, _ message: String = "no", code: String? = nil, method: String = "GET") -> APIError {
    APIError(method: method, status: status, message: message, code: code, currentVersion: nil)
  }

  func testCancellationIsUserCancelled() {
    // Finder cancels routinely. Reporting that as a server problem puts an
    // error in front of someone who simply pressed stop.
    let mapped = providerError(CancellationError()) as NSError
    XCTAssertEqual(mapped.domain, NSCocoaErrorDomain)
    XCTAssertEqual(mapped.code, NSUserCancelledError)
  }

  func testAuthenticationAndMissingItems() {
    XCTAssertEqual((providerError(api(401)) as NSError).code, NSFileProviderError.notAuthenticated.rawValue)
    XCTAssertEqual((providerError(api(404)) as NSError).code, NSFileProviderError.noSuchItem.rawValue)
  }

  func testForbiddenDependsOnDirection() {
    XCTAssertEqual((providerError(api(403, method: "GET")) as NSError).code, NSFileReadNoPermissionError)
    XCTAssertEqual((providerError(api(403, method: "PUT")) as NSError).code, NSFileWriteNoPermissionError)
  }

  func testNameCollisionAndQuota() {
    let collision = api(409, "A file named a.txt already exists")
    XCTAssertTrue(collision.isNameCollision)
    XCTAssertEqual((providerError(collision) as NSError).code, NSFileProviderError.filenameCollision.rawValue)
    XCTAssertEqual((providerError(api(400, "storage limit reached")) as NSError).code,
                   NSFileProviderError.insufficientQuota.rawValue)
  }

  func testAVersionConflictCountsAsANameCollision() {
    // Upload init answers version_conflict when the name is taken, and the
    // uploader has to read that as "try the next candidate", not as a failure.
    XCTAssertTrue(api(409, "stale", code: "version_conflict").isNameCollision)
    XCTAssertFalse(api(409, "something else", code: "other").isNameCollision)
  }

  func testServerTroubleIsRetryable() {
    for status in [429, 500, 503] {
      XCTAssertEqual((providerError(api(status)) as NSError).code,
                     NSFileProviderError.serverUnreachable.rawValue, "status \(status)")
    }
  }
}
