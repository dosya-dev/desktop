import XCTest
@testable import DosyaFileProviderCore

final class NamingTests: XCTestCase {
  func testLockDetection() {
    XCTAssertFalse(isLocked(nil))
    XCTAssertFalse(isLocked(""))
    XCTAssertFalse(isLocked("none"))
    XCTAssertTrue(isLocked("view_only"))
    XCTAssertTrue(isLocked("full"))
  }

  func testCandidateNamesKeepTheExtension() {
    let c = candidateNames("Report.pdf")
    XCTAssertEqual(c.first, "Report.pdf")
    XCTAssertEqual(c[1], "Report 2.pdf")
    XCTAssertEqual(c.last, "Report 20.pdf")
    XCTAssertEqual(c.count, 20)
  }

  func testCandidateNamesWithoutAnExtension() {
    XCTAssertEqual(Array(candidateNames("notes").prefix(2)), ["notes", "notes 2"])
  }

  func testWorkspacesWithOneNameAreToldApart() {
    let dupes = [
      WorkspaceDTO(id: "w1", name: "Home", slug: "home", e2ee_mode: 0, created_at: nil),
      WorkspaceDTO(id: "w2", name: "home", slug: nil, e2ee_mode: 0, created_at: nil),
      WorkspaceDTO(id: "w3", name: "Work", slug: nil, e2ee_mode: 0, created_at: nil),
    ]
    XCTAssertEqual(disambiguateWorkspaceNames(dupes).map(\.name), ["Home (home)", "home (w2)", "Work"])
  }

  func testAUniqueNameIsLeftAlone() {
    let one = [WorkspaceDTO(id: "w1", name: "Home", slug: "home", e2ee_mode: 0, created_at: nil)]
    XCTAssertEqual(disambiguateWorkspaceNames(one).map(\.name), ["Home"])
  }
}
