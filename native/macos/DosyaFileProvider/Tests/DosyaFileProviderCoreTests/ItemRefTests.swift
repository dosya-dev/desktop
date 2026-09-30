import FileProvider
import XCTest
@testable import DosyaFileProviderCore

final class ItemRefTests: XCTestCase {
  func testRoundTripsEveryKind() {
    let refs: [ItemRef] = [.root, .workspace("w1"), .folder("f1"), .file("x1")]
    for ref in refs {
      XCTAssertEqual(ItemRef(ref.identifier), ref, "\(ref) did not survive a round trip")
    }
  }

  func testRootIsTheFrameworkRootContainer() {
    XCTAssertEqual(ItemRef.root.identifier, .rootContainer)
    XCTAssertEqual(ItemRef(.rootContainer), .root)
  }

  func testRejectsUnknownAndTruncatedIdentifiers() {
    for raw in ["", "zz:1", "fo", "x", ":"] {
      XCTAssertNil(ItemRef(NSFileProviderItemIdentifier(raw)), "accepted \(raw)")
    }
  }

  func testContainerIsTheWorkspaceWhenTheFolderIsNilOrEmpty() {
    XCTAssertEqual(ItemRef.container(workspaceId: "w1", folderId: nil), .workspace("w1"))
    XCTAssertEqual(ItemRef.container(workspaceId: "w1", folderId: ""), .workspace("w1"))
    XCTAssertEqual(ItemRef.container(workspaceId: "w1", folderId: "f1"), .folder("f1"))
  }
}
