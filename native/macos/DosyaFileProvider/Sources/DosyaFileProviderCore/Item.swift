import FileProvider
import Foundation
import UniformTypeIdentifiers

/// What an item identifier points at. Ids are prefixed by kind because the API
/// addresses files, folders and workspaces through different routes, and the system
/// hands back nothing but the identifier.
enum ItemRef: Equatable {
  case root
  case workspace(String)
  case folder(String)
  case file(String)

  init?(_ identifier: NSFileProviderItemIdentifier) {
    if identifier == .rootContainer { self = .root; return }
    let raw = identifier.rawValue
    guard raw.count > 3 else { return nil }
    let id = String(raw.dropFirst(3))
    switch raw.prefix(3) {
    case "ws:": self = .workspace(id)
    case "fo:": self = .folder(id)
    case "fi:": self = .file(id)
    default: return nil
    }
  }

  var identifier: NSFileProviderItemIdentifier {
    switch self {
    case .root: return .rootContainer
    case .workspace(let id): return NSFileProviderItemIdentifier("ws:" + id)
    case .folder(let id): return NSFileProviderItemIdentifier("fo:" + id)
    case .file(let id): return NSFileProviderItemIdentifier("fi:" + id)
    }
  }

  /// The container a folder_id / parent_id lands in: the folder, or the
  /// workspace root when the API says null - or names the folder a confined
  /// member's view is rooted at, which Files shows as the workspace itself.
  static func container(workspaceId: String, folderId: String?) -> ItemRef {
    guard let folderId, !folderId.isEmpty, folderId != WorkspaceAnchors.anchor(of: workspaceId) else {
      return .workspace(workspaceId)
    }
    return .folder(folderId)
  }
}

/// Folder-confined members see one folder of a workspace as its root. The sync
/// feed names that folder; this remembers it (persisted with SyncState) so every
/// item built anywhere in the extension maps it onto the workspace root.
enum WorkspaceAnchors {
  private static let lock = NSLock()
  private static var cache: [String: String]?

  static func anchor(of workspaceId: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    if cache == nil { cache = SyncState.load().anchors }
    return cache?[workspaceId]
  }

  static func update(_ anchors: [String: String]) {
    lock.lock()
    cache = anchors
    lock.unlock()
  }
}

/// Folders under a view-only or full lock are left out, matching the sync feed,
/// which drops their whole subtree: Finder cannot prompt for the passphrase.
/// A file's OWN lock is not filtered - the sync feed does not report it, and an
/// item that vanished on every folder browse and came back on every poll would
/// be worse than one that explains it is locked when opened.
func isLocked(_ mode: String?) -> Bool {
  guard let mode else { return false }
  return mode != "none" && !mode.isEmpty
}

final class Item: NSObject, NSFileProviderItem {
  let itemIdentifier: NSFileProviderItemIdentifier
  let parentItemIdentifier: NSFileProviderItemIdentifier
  let filename: String
  let contentType: UTType
  let capabilities: NSFileProviderItemCapabilities
  let documentSize: NSNumber?
  let creationDate: Date?
  let contentModificationDate: Date?
  let itemVersion: NSFileProviderItemVersion

  private init(
    ref: ItemRef,
    parent: ItemRef,
    filename: String,
    contentType: UTType,
    capabilities: NSFileProviderItemCapabilities,
    size: Int64? = nil,
    created: Double? = nil,
    modified: Double? = nil,
    contentVersion: String,
    metadataVersion: String
  ) {
    itemIdentifier = ref.identifier
    parentItemIdentifier = parent.identifier
    self.filename = filename
    self.contentType = contentType
    self.capabilities = capabilities
    documentSize = size.map { NSNumber(value: $0) }
    creationDate = created.map { Date(timeIntervalSince1970: $0) }
    contentModificationDate = (modified ?? created).map { Date(timeIntervalSince1970: $0) }
    itemVersion = NSFileProviderItemVersion(
      contentVersion: Data(contentVersion.utf8),
      metadataVersion: Data(metadataVersion.utf8)
    )
  }

  static func root() -> Item {
    Item(ref: .root, parent: .root, filename: "dosya.dev", contentType: .folder,
         capabilities: [.allowsContentEnumerating, .allowsReading],
         contentVersion: "root", metadataVersion: "root")
  }

  /// Workspaces are top-level folders that cannot be renamed, moved or deleted
  /// from Files.
  static func workspace(_ ws: WorkspaceDTO) -> Item {
    Item(ref: .workspace(ws.id), parent: .root, filename: ws.name, contentType: .folder,
         capabilities: [.allowsContentEnumerating, .allowsReading, .allowsAddingSubItems],
         created: ws.created_at,
         contentVersion: "ws", metadataVersion: ws.name)
  }

  static func folder(id: String, name: String, parent: ItemRef, created: Double?) -> Item {
    Item(ref: .folder(id), parent: parent, filename: name, contentType: .folder,
         capabilities: [.allowsContentEnumerating, .allowsReading, .allowsAddingSubItems,
                        .allowsRenaming, .allowsReparenting, .allowsDeleting],
         created: created,
         // Name and parent only: the listing and the sync feed both carry them,
         // so an item seen through either reads as the same version.
         contentVersion: "folder", metadataVersion: "\(name)|\(parent.identifier.rawValue)")
  }

  static func file(_ f: FileDTO, parent: ItemRef) -> Item {
    let ext = (f.extension ?? (f.name as NSString).pathExtension)
      .trimmingCharacters(in: CharacterSet(charactersIn: "."))
    let type = UTType(filenameExtension: ext) ?? .data
    let size = f.size_bytes ?? 0
    let version = f.current_version ?? 1
    return Item(ref: .file(f.id), parent: parent, filename: f.name, contentType: type,
                capabilities: [.allowsReading, .allowsWriting, .allowsRenaming,
                               .allowsReparenting, .allowsDeleting],
                size: size, created: f.created_at, modified: f.updated_at,
                contentVersion: "\(version)|\(size)",
                // No timestamp: the listing reports a display time (source
                // modified time when known) and the sync feed the raw row time,
                // so including either would flip the version between the two.
                metadataVersion: "\(f.name)|\(parent.identifier.rawValue)")
  }

  /// The version number this item's content was read at, for optimistic upload.
  static func serverVersion(of version: NSFileProviderItemVersion) -> Int? {
    guard let text = String(data: version.contentVersion, encoding: .utf8),
          let first = text.split(separator: "|").first
    else { return nil }
    return Int(first)
  }
}

/// "Report.pdf", then "Report 2.pdf", "Report 3.pdf"... Finder expects the
/// provider to settle name clashes; the item it gets back carries the final name.
func candidateNames(_ name: String) -> [String] {
  let ns = name as NSString
  let ext = ns.pathExtension
  let stem = ext.isEmpty ? name : ns.deletingPathExtension
  return [name] + (2...20).map { ext.isEmpty ? "\(stem) \($0)" : "\(stem) \($0).\(ext)" }
}
