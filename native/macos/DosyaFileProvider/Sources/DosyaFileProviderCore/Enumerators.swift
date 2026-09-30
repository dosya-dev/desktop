import FileProvider
import Foundation

private let pageSize = 500

private func encodePage<T: Encodable>(_ value: T) -> NSFileProviderPage? {
  (try? JSONEncoder().encode(value)).map { NSFileProviderPage($0) }
}

private func decodePage<T: Decodable>(_ page: NSFileProviderPage, as type: T.Type) -> T? {
  let raw = page.rawValue
  if raw == NSFileProviderPage.initialPageSortedByName as Data
    || raw == NSFileProviderPage.initialPageSortedByDate as Data { return nil }
  return try? JSONDecoder().decode(T.self, from: raw)
}

/// A workspace this member can no longer read (removed, role changed, lost
/// access to files). Skipped rather than failing every workspace's sync.
private func isWorkspaceGone(_ error: Error) -> Bool {
  guard let api = error as? APIError else { return false }
  return api.status == 403 || api.status == 404
}

// MARK: - Folder listings

/// Lists one container for Files: the root (workspaces), a workspace root, or a
/// folder. Change tracking is not done here - the working set enumerator reports
/// every change, which is what a replicated extension is asked for.
final class ContainerEnumerator: NSObject, NSFileProviderEnumerator {
  private struct Page: Codable { let page: Int; let workspaceId: String }

  private let ref: ItemRef
  private let api: APIClient
  private var task: Task<Void, Never>?

  init(ref: ItemRef, api: APIClient) {
    self.ref = ref
    self.api = api
  }

  func invalidate() {
    task?.cancel()
  }

  func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
    task = Task {
      do {
        switch ref {
        case .root:
          let list = try await api.workspaces(fresh: true)
          observer.didEnumerate(list.map(Item.workspace))
          observer.finishEnumerating(upTo: nil)
        case .workspace(let workspaceId):
          try await listFolder(workspaceId: workspaceId, folderId: nil, page: page, observer: observer)
        case .folder(let folderId):
          let workspaceId: String
          if let state = decodePage(page, as: Page.self) {
            workspaceId = state.workspaceId
          } else {
            let folder = try await api.get(FolderResponse.self, "/api/folders/\(folderId)").folder
            guard let ws = folder.workspace_id, folder.is_deleted != 1 else { throw NSFileProviderError(.noSuchItem) }
            workspaceId = ws
          }
          try await listFolder(workspaceId: workspaceId, folderId: folderId, page: page, observer: observer)
        case .file:
          throw NSFileProviderError(.noSuchItem)
        }
      } catch {
        observer.finishEnumeratingWithError(providerError(error))
      }
    }
  }

  private func listFolder(workspaceId: String, folderId: String?, page: NSFileProviderPage,
                          observer: NSFileProviderEnumerationObserver) async throws {
    let number = decodePage(page, as: Page.self)?.page ?? 1
    let listing = try await api.get(ListingResponse.self, "/api/files", query: [
      "workspace_id": workspaceId,
      "folder_id": folderId,
      "page": String(number),
      "per_page": String(pageSize),
      "sort": "name_asc",
    ])
    let parent = ItemRef.container(workspaceId: workspaceId, folderId: folderId)
    var items: [NSFileProviderItem] = []
    // Child folders ride along on every page; report them once.
    if number == 1 {
      items += (listing.folders ?? []).filter { !isLocked($0.lock_mode) }
        .map { Item.folder(id: $0.id, name: $0.name, parent: parent, created: $0.created_at) }
    }
    items += (listing.files ?? []).map { Item.file($0, parent: parent) }
    observer.didEnumerate(items)

    let totalPages = listing.pagination?.total_pages ?? 1
    observer.finishEnumerating(upTo: number < totalPages ? encodePage(Page(page: number + 1, workspaceId: workspaceId)) : nil)
  }

  func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
    observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
  }

  func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
    completionHandler(NSFileProviderSyncAnchor(Data("container".utf8)))
  }
}

// MARK: - Working set

/// What the working set last saw of workspaces and folders. The sync feed
/// returns the whole visible folder tree on every poll rather than a delta, so a
/// folder renamed, moved, locked or hard-deleted is only detectable by comparing
/// against this.
struct SyncState: Codable {
  var workspaces: [String: String] = [:]
  /// workspace id -> folder id -> "name|parent_id"
  var folders: [String: [String: String]] = [:]
  /// workspace id -> the folder a confined member's view is rooted at
  var anchors: [String: String] = [:]

  /// The extension's own container, not an App Group one. Nothing else reads
  /// this file, and on macOS a group container URL resolves only for a group the
  /// process is entitled to, which would have made this silently nil and left
  /// the diff baseline permanently empty: deleted workspaces and newly locked
  /// folders would then go unreported until the next full resync.
  private static var fileURL: URL? {
    guard let base = try? FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ) else { return nil }
    let directory = base.appendingPathComponent("DosyaFileProvider", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("sync-state.json")
  }

  static func load() -> SyncState {
    guard let url = fileURL, let data = try? Data(contentsOf: url),
          let state = try? JSONDecoder().decode(SyncState.self, from: data)
    else { return SyncState() }
    return state
  }

  func save() {
    WorkspaceAnchors.update(anchors)
    guard let url = Self.fileURL, let data = try? JSONEncoder().encode(self) else { return }
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: url, options: .atomic)
  }

  /// Records a workspace's folder tree from a snapshot's first page. The anchor
  /// is published before any item is built from the page, so folders directly
  /// under it already map onto the workspace root.
  mutating func record(workspaceId: String, page: SnapshotResponse) {
    anchors[workspaceId] = page.root_folder_id
    WorkspaceAnchors.update(anchors)
    folders[workspaceId] = Dictionary(
      (page.folders ?? []).map { ($0.id, "\($0.name)|\($0.parent_id ?? "")") },
      uniquingKeysWith: { first, _ in first }
    )
  }
}

/// Anchor = the server time to ask for changes after (`since`), plus when the
/// working set was last enumerated in full.
private struct Anchor: Codable {
  let since: Double
  let fullAt: Double

  var data: NSFileProviderSyncAnchor { NSFileProviderSyncAnchor((try? JSONEncoder().encode(self)) ?? Data()) }

  init(since: Double, fullAt: Double) {
    self.since = since
    self.fullAt = fullAt
  }

  init?(_ anchor: NSFileProviderSyncAnchor) {
    guard let value = try? JSONDecoder().decode(Anchor.self, from: anchor.rawValue) else { return nil }
    self = value
  }
}

/// Polls overlap by this much, so a file written while a poll was running is
/// never skipped. Seeing an unchanged item twice is harmless.
private let pollOverlap: Double = 300
/// Tombstones do not cover hard deletes, newly locked folders or files hidden
/// from this member. A daily full enumeration catches all of those.
private let fullResyncInterval: Double = 24 * 3600

final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
  private struct Page: Codable { let workspaceIndex: Int; let cursor: String? }

  private let api: APIClient
  private var task: Task<Void, Never>?

  init(api: APIClient) {
    self.api = api
  }

  func invalidate() {
    task?.cancel()
  }

  func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
    Task {
      let now = await api.serverNow()
      completionHandler(Anchor(since: now - pollOverlap, fullAt: now).data)
    }
  }

  func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
    task = Task {
      do {
        let position = decodePage(page, as: Page.self) ?? Page(workspaceIndex: -1, cursor: nil)
        var state = SyncState.load()
        let workspaces = try await api.workspaces(fresh: position.workspaceIndex < 0)

        if position.workspaceIndex < 0 {
          state = SyncState()
          state.workspaces = Dictionary(workspaces.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
          state.save()
          observer.didEnumerate(workspaces.map(Item.workspace))
          observer.finishEnumerating(upTo: workspaces.isEmpty ? nil : encodePage(Page(workspaceIndex: 0, cursor: nil)))
          return
        }
        guard position.workspaceIndex < workspaces.count else {
          observer.finishEnumerating(upTo: nil)
          return
        }

        let ws = workspaces[position.workspaceIndex]
        let nextWorkspace = position.workspaceIndex + 1 < workspaces.count
          ? Page(workspaceIndex: position.workspaceIndex + 1, cursor: nil) : nil

        let snapshot: SnapshotResponse
        do {
          snapshot = try await api.get(SnapshotResponse.self, "/api/sync/snapshot", query: [
            "workspace_id": ws.id,
            "cursor": position.cursor,
            "limit": "1000",
          ])
        } catch where isWorkspaceGone(error) {
          observer.finishEnumerating(upTo: nextWorkspace.flatMap { encodePage($0) })
          return
        }

        var items: [NSFileProviderItem] = []
        if position.cursor == nil {
          state.record(workspaceId: ws.id, page: snapshot)
          state.save()
          items += (snapshot.folders ?? []).map {
            Item.folder(id: $0.id, name: $0.name, parent: .container(workspaceId: ws.id, folderId: $0.parent_id), created: nil)
          }
        }
        items += (snapshot.files ?? []).map { Item.file($0, parent: .container(workspaceId: ws.id, folderId: $0.folder_id)) }
        observer.didEnumerate(items)

        let next: Page? = (snapshot.hasMore ?? false) && snapshot.nextCursor != nil
          ? Page(workspaceIndex: position.workspaceIndex, cursor: snapshot.nextCursor)
          : nextWorkspace
        observer.finishEnumerating(upTo: next.flatMap { encodePage($0) })
      } catch {
        observer.finishEnumeratingWithError(providerError(error))
      }
    }
  }

  func enumerateChanges(for observer: NSFileProviderChangeObserver, from syncAnchor: NSFileProviderSyncAnchor) {
    task = Task {
      do {
        // Workspaces first: it is also the request that calibrates the clock.
        let workspaces = try await api.workspaces(fresh: true)
        let pollStartedAt = await api.serverNow()
        guard let anchor = Anchor(syncAnchor), pollStartedAt - anchor.fullAt < fullResyncInterval else {
          throw NSFileProviderError(.syncAnchorExpired)
        }

        var state = SyncState.load()
        let current = Set(workspaces.map(\.id))
        let removed = state.workspaces.keys.filter { !current.contains($0) }
        if !removed.isEmpty {
          observer.didDeleteItems(withIdentifiers: removed.map { ItemRef.workspace($0).identifier })
          for id in removed {
            state.folders[id] = nil
            state.anchors[id] = nil
          }
        }
        let renamed = workspaces.filter { state.workspaces[$0.id] != $0.name }
        if !renamed.isEmpty { observer.didUpdate(renamed.map(Item.workspace)) }
        state.workspaces = Dictionary(workspaces.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })

        for ws in workspaces {
          try Task.checkCancellation()
          do {
            try await pollWorkspace(ws, since: anchor.since, state: &state, observer: observer)
          } catch where isWorkspaceGone(error) {
            observer.didDeleteItems(withIdentifiers: [ItemRef.workspace(ws.id).identifier])
            state.folders[ws.id] = nil
          }
        }

        state.save()
        observer.finishEnumeratingChanges(
          upTo: Anchor(since: pollStartedAt - pollOverlap, fullAt: anchor.fullAt).data,
          moreComing: false
        )
      } catch {
        observer.finishEnumeratingWithError(providerError(error))
      }
    }
  }

  /// One workspace's changes since `since`, reported page by page so a bulk
  /// change never has to fit in the extension's memory at once.
  private func pollWorkspace(_ ws: WorkspaceDTO, since: Double, state: inout SyncState,
                             observer: NSFileProviderChangeObserver) async throws {
    var cursor: String? = nil
    repeat {
      let page = try await api.get(SnapshotResponse.self, "/api/sync/snapshot", query: [
        "workspace_id": ws.id,
        "since": String(Int(since)),
        "cursor": cursor,
        "limit": "1000",
      ])
      if cursor == nil {
        // Truncated tombstones withhold every id; only a full pass is safe.
        if page.deleted?.truncated == true { throw NSFileProviderError(.syncAnchorExpired) }
        let tombstonedFolders = Set(page.deleted?.folders ?? [])
        var deletions = (page.deleted?.files ?? []).map { ItemRef.file($0).identifier }
        deletions += tombstonedFolders.map { ItemRef.folder($0).identifier }

        let previous = state.folders[ws.id] ?? [:]
        state.record(workspaceId: ws.id, page: page)
        let seen = state.folders[ws.id] ?? [:]
        let changedFolders = (page.folders ?? []).filter { previous[$0.id] != seen[$0.id] }
        deletions += previous.keys.filter { seen[$0] == nil && !tombstonedFolders.contains($0) }
          .map { ItemRef.folder($0).identifier }

        if !deletions.isEmpty { observer.didDeleteItems(withIdentifiers: deletions) }
        if !changedFolders.isEmpty {
          observer.didUpdate(changedFolders.map {
            Item.folder(id: $0.id, name: $0.name, parent: .container(workspaceId: ws.id, folderId: $0.parent_id), created: nil)
          })
        }
      }
      let files = page.files ?? []
      if !files.isEmpty {
        observer.didUpdate(files.map { Item.file($0, parent: .container(workspaceId: ws.id, folderId: $0.folder_id)) })
      }
      cursor = (page.hasMore ?? false) ? page.nextCursor : nil
    } while cursor != nil
  }
}
