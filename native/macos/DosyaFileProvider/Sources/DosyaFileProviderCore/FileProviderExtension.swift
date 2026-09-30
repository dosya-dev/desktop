import FileProvider
import Foundation
import UniformTypeIdentifiers

/// JSONSerialization throws an Objective-C exception (a crash, not a Swift
/// error) on a bare Optional. `null` has to be NSNull.
private func jsonValue(_ value: String?) -> Any {
  value ?? NSNull()
}

/// dosya.dev in Finder, under Locations.
///
/// A replicated File Provider: macOS keeps the local copies, schedules the work and
/// retries on failure; this class only answers "what is this item", "give me its
/// bytes" and "apply this change on the server". Everything goes through the
/// same REST routes the app uses, under the extension's own linked session.
/// The Objective-C name is the contract with Info.plist's NSExtensionPrincipalClass:
/// Swift mangles class names per module, and macOS looks the class up by the
/// string in the plist. Pinning it here means renaming the Swift class cannot
/// silently leave macOS with a bundle it can load but not instantiate.
@objc(DosyaFileProviderExtension)
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
  private let domain: NSFileProviderDomain
  private let api = APIClient.live

  required init(domain: NSFileProviderDomain) {
    self.domain = domain
    super.init()
  }

  func invalidate() {}

  // MARK: Plumbing

  /// Runs async work for a completion-handler API, wiring Files' cancel button
  /// to the task and mapping errors into the File Provider domain.
  private func run<T>(
    _ progress: Progress,
    _ work: @escaping () async throws -> T,
    _ done: @escaping (Result<T, Error>) -> Void
  ) {
    let task = Task {
      do {
        done(.success(try await work()))
      } catch {
        done(.failure(providerError(error)))
      }
    }
    progress.cancellationHandler = { task.cancel() }
  }

  private func unsupported(_ message: String) -> Error {
    CocoaError(.featureUnsupported, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func scratchURL(_ name: String) throws -> URL {
    let base = try NSFileProviderManager(for: domain)?.temporaryDirectoryURL()
      ?? FileManager.default.temporaryDirectory
    return base.appendingPathComponent(UUID().uuidString + "-" + name)
  }

  // MARK: Lookup

  func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
            completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    run(progress, { try await self.lookup(identifier) }) { result in
      switch result {
      case .success(let item): completionHandler(item, nil)
      case .failure(let error): completionHandler(nil, error)
      }
    }
    return progress
  }

  private func lookup(_ identifier: NSFileProviderItemIdentifier) async throws -> Item {
    guard let ref = ItemRef(identifier) else { throw NSFileProviderError(.noSuchItem) }
    switch ref {
    case .root:
      return Item.root()
    case .workspace(let id):
      guard let ws = try await api.workspaces().first(where: { $0.id == id }) else { throw NSFileProviderError(.noSuchItem) }
      return Item.workspace(ws)
    case .folder(let id):
      let folder = try await folderRecord(id)
      return Item.folder(id: folder.id, name: folder.name,
                         parent: .container(workspaceId: folder.workspace_id ?? "", folderId: folder.parent_id),
                         created: folder.created_at)
    case .file(let id):
      let file = try await fileRecord(id)
      return Item.file(file, parent: .container(workspaceId: file.workspace_id ?? "", folderId: file.folder_id))
    }
  }

  /// A live folder, or noSuchItem. GET /api/folders/:id still answers for a
  /// trashed folder, which Files must not show.
  private func folderRecord(_ id: String) async throws -> FolderDTO {
    let folder = try await api.get(FolderResponse.self, "/api/folders/\(id)").folder
    guard folder.is_deleted != 1, folder.workspace_id != nil else { throw NSFileProviderError(.noSuchItem) }
    return folder
  }

  /// A live file, or noSuchItem. GET /api/files/:id answers for a trashed file
  /// too.
  private func fileRecord(_ id: String) async throws -> FileDTO {
    let file = try await api.get(FileResponse.self, "/api/files/\(id)").file
    guard file.deleted_at == nil, file.workspace_id != nil else {
      throw NSFileProviderError(.noSuchItem)
    }
    return file
  }

  /// The workspace and folder an item created under `parent` belongs in.
  private func destination(_ parent: NSFileProviderItemIdentifier) async throws -> (workspaceId: String, folderId: String?) {
    switch ItemRef(parent) {
    case .workspace(let id): return (id, nil)
    case .folder(let id): return (try await folderRecord(id).workspace_id ?? "", id)
    case .root: throw unsupported("Choose a workspace. Items can't be added next to your workspaces.")
    default: throw NSFileProviderError(.noSuchItem)
    }
  }

  // MARK: Enumeration

  func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier,
                  request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
    if containerItemIdentifier == .workingSet { return WorkingSetEnumerator(api: api) }
    guard let ref = ItemRef(containerItemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
    if case .file = ref { throw NSFileProviderError(.noSuchItem) }
    return ContainerEnumerator(ref: ref, api: api)
  }

  // MARK: Download

  func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                     request: NSFileProviderRequest,
                     completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
    let progress = Progress(totalUnitCount: 100)
    run(progress, {
      guard case .file(let id) = ItemRef(itemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
      let file = try await self.fileRecord(id)
      if isLocked(file.lock_mode) {
        throw CocoaError(.fileReadNoPermission, userInfo: [
          NSLocalizedDescriptionKey: "\(file.name) is locked. Open it in the dosya.dev app.",
        ])
      }
      let link = try await self.api.get(DownloadURLResponse.self, "/api/files/\(id)/download-url")
      guard let raw = link.url ?? link.download_url, let remote = URL(string: raw) else {
        throw NSFileProviderError(.serverUnreachable)
      }
      let local = try self.scratchURL(file.name)
      try await self.api.download(remote, to: local)
      progress.completedUnitCount = 100
      return (local, Item.file(file, parent: .container(workspaceId: file.workspace_id ?? "", folderId: file.folder_id)))
    }) { result in
      switch result {
      case .success(let (url, item)): completionHandler(url, item, nil)
      case .failure(let error): completionHandler(nil, nil, error)
      }
    }
    return progress
  }

  // MARK: Create

  func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                  options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest,
                  completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
    let progress = Progress(totalUnitCount: 100)
    run(progress, {
      let type = itemTemplate.contentType ?? .data
      let (workspaceId, folderId) = try await self.destination(itemTemplate.parentItemIdentifier)
      let parent = ItemRef.container(workspaceId: workspaceId, folderId: folderId)

      if type.conforms(to: .folder) {
        return try await self.createFolder(named: itemTemplate.filename, workspaceId: workspaceId,
                                           folderId: folderId, parent: parent,
                                           adoptExisting: options.contains(.mayAlreadyExist))
      }
      if type.conforms(to: .symbolicLink) || type.conforms(to: .package) || type.conforms(to: .aliasFile) {
        // Bundles are directories on disk and links point outside the account;
        // neither round-trips through a file upload.
        throw self.unsupported("dosya.dev can't store packages or links. Compress it to a .zip first.")
      }

      let source: URL
      if let url {
        source = url
      } else {
        source = try self.scratchURL("empty")
        FileManager.default.createFile(atPath: source.path, contents: Data())
      }
      let size = (try? FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.int64Value ?? 0
      if options.contains(.mayAlreadyExist),
         let existing = try await self.findChildFile(named: itemTemplate.filename, size: size,
                                                     workspaceId: workspaceId, folderId: folderId) {
        // The system re-importing items it already had (after a reset): the same name and
        // size is the same file, not a second copy to upload as "name 2".
        return Item.file(existing, parent: parent)
      }
      let uploaded = try await self.uploadNewFile(source, named: itemTemplate.filename, type: type,
                                                  workspaceId: workspaceId, folderId: folderId, progress: progress)
      return Item.file(uploaded, parent: parent)
    }) { result in
      switch result {
      case .success(let item): completionHandler(item, [], false, nil)
      case .failure(let error): completionHandler(nil, [], false, error)
      }
    }
    return progress
  }

  private func createFolder(named name: String, workspaceId: String, folderId: String?, parent: ItemRef,
                            adoptExisting: Bool) async throws -> Item {
    // POST /api/folders treats "/" and "\\" as path separators and would create
    // nested folders; a Files folder name containing one is a single name.
    guard !name.contains("/"), !name.contains("\\") else {
      throw CocoaError(.fileWriteInvalidFileName, userInfo: [
        NSLocalizedDescriptionKey: "Folder names on dosya.dev can't contain / or \\.",
      ])
    }
    for candidate in candidateNames(name) {
      let data: Data
      do {
        data = try await api.send("POST", "/api/folders", json: [
          "workspace_id": workspaceId,
          "parent_id": jsonValue(folderId),
          "name": candidate,
        ])
      } catch let error as APIError where error.isNameCollision {
        continue
      }
      let response = try JSONDecoder().decode(FolderResponse.self, from: data)
      // The route is find-or-create: created_count 0 hands back the folder that
      // already had this name. Only a re-import may adopt it; a new folder from
      // the user takes the next free name instead of merging into it.
      if response.created_count == 0 && !adoptExisting { continue }
      let folder = response.folder
      return Item.folder(id: folder.id, name: folder.name, parent: parent, created: Date().timeIntervalSince1970)
    }
    throw NSFileProviderError(.filenameCollision)
  }

  private func findChildFile(named name: String, size: Int64, workspaceId: String, folderId: String?) async throws -> FileDTO? {
    let listing = try await api.get(ListingResponse.self, "/api/files", query: [
      "workspace_id": workspaceId, "folder_id": folderId, "q": name, "page": "1", "per_page": "100",
    ])
    return listing.files?.first { $0.name == name && ($0.size_bytes ?? -1) == size }
  }

  /// Uploads a brand-new file. `expected_version: 0` makes the server refuse
  /// with version_conflict when the name is already taken, instead of silently
  /// turning this upload into a new version of the file that owns the name.
  private func uploadNewFile(_ source: URL, named name: String, type: UTType, workspaceId: String,
                             folderId: String?, progress: Progress) async throws -> FileDTO {
    for candidate in candidateNames(name) {
      do {
        return try await upload(source, name: candidate, type: type, workspaceId: workspaceId, folderId: folderId,
                                extra: ["expected_version": 0], progress: progress)
      } catch let error as APIError where error.isNameCollision {
        continue
      }
    }
    throw NSFileProviderError(.filenameCollision)
  }

  /// POST /api/upload/init, then one PUT (up to 50 MB) or 10 MB parts plus
  /// complete. Parts are read one at a time to stay inside the extension's
  /// memory limit.
  private func upload(_ source: URL, name: String, type: UTType, workspaceId: String, folderId: String?,
                      extra: [String: Any], progress: Progress) async throws -> FileDTO {
    let size = (try FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.int64Value ?? 0
    let mime = type.preferredMIMEType ?? "application/octet-stream"
    var body: [String: Any] = [
      "workspace_id": workspaceId,
      "file_name": name,
      "file_size": size,
      "mime_type": mime,
      "folder_id": jsonValue(folderId),
    ]
    body.merge(extra) { _, new in new }
    let initData = try await api.send("POST", "/api/upload/init", json: body)
    let session = try JSONDecoder().decode(UploadInitResponse.self, from: initData)

    let resultData: Data
    if let parts = session.resumable {
      let handle = try FileHandle(forReadingFrom: source)
      defer { try? handle.close() }
      for part in 1...max(parts.total_parts, 1) {
        try Task.checkCancellation()
        try handle.seek(toOffset: UInt64(part - 1) * UInt64(parts.part_size))
        let chunk = try handle.read(upToCount: parts.part_size) ?? Data()
        _ = try await api.send("PUT", "\(parts.part_upload_url)/\(part)", body: chunk,
                               contentType: "application/octet-stream")
        progress.completedUnitCount = Int64(95 * part / max(parts.total_parts, 1))
      }
      resultData = try await api.send("POST", parts.complete_url, json: [:])
    } else {
      resultData = try await api.send("PUT", session.upload_url, upload: source, contentType: mime)
    }
    progress.completedUnitCount = 100

    let uploaded = try JSONDecoder().decode(UploadedFileResponse.self, from: resultData).file
    let now = Date().timeIntervalSince1970
    return FileDTO(id: uploaded.id, name: uploaded.name, size_bytes: uploaded.size_bytes ?? size,
                   mime_type: uploaded.mime_type ?? mime, extension: nil, folder_id: folderId,
                   workspace_id: workspaceId, lock_mode: "none", current_version: uploaded.version ?? 1,
                   created_at: uploaded.created_at ?? now, updated_at: uploaded.created_at ?? now, deleted_at: nil)
  }

  // MARK: Modify

  func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion,
                  changedFields: NSFileProviderItemFields, contents newContents: URL?,
                  options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                  completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
    let progress = Progress(totalUnitCount: 100)
    run(progress, { () -> (Item, Bool) in
      guard let ref = ItemRef(item.itemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
      let structural: NSFileProviderItemFields = [.filename, .parentItemIdentifier, .contents]
      switch ref {
      case .root, .workspace:
        if !changedFields.intersection(structural).isEmpty {
          throw self.unsupported("Workspaces can be renamed or removed only in the dosya.dev app.")
        }
        return (try await self.lookup(item.itemIdentifier), false)
      case .folder(let id):
        let folder = try await self.folderRecord(id)
        if changedFields.contains(.filename), item.filename != folder.name {
          _ = try await self.api.send("PUT", "/api/folders/\(id)/rename", json: ["name": item.filename])
        }
        if changedFields.contains(.parentItemIdentifier) {
          let target = try await self.destination(item.parentItemIdentifier)
          guard target.workspaceId == folder.workspace_id else {
            throw self.unsupported("Moving between workspaces isn't supported yet. Copy the folder instead.")
          }
          if target.folderId != folder.parent_id {
            _ = try await self.api.send("PUT", "/api/folders/\(id)/move", json: ["parent_id": jsonValue(target.folderId)])
          }
        }
        return (try await self.lookup(item.itemIdentifier), false)
      case .file(let id):
        let file = try await self.fileRecord(id)
        let workspaceId = file.workspace_id ?? ""
        if changedFields.contains(.filename), item.filename != file.name {
          _ = try await self.api.send("PUT", "/api/files/\(id)/rename", json: ["name": item.filename])
        }
        if changedFields.contains(.parentItemIdentifier) {
          let target = try await self.destination(item.parentItemIdentifier)
          guard target.workspaceId == workspaceId else {
            throw self.unsupported("Moving between workspaces isn't supported yet. Copy the file instead.")
          }
          if target.folderId != file.folder_id {
            _ = try await self.api.send("PUT", "/api/files/\(id)/move", json: ["folder_id": jsonValue(target.folderId)])
          }
        }
        var conflicted = false
        if changedFields.contains(.contents), let newContents {
          conflicted = try await self.uploadEdit(newContents, of: file, name: item.filename,
                                                 type: item.contentType ?? .data, baseVersion: version, progress: progress)
        }
        // After a conflict the local bytes are the user's edit (now saved as a
        // separate copy), not the server's newer version. shouldFetchContent makes
        // macOS replace them; without it, the next save would go up on top of the
        // newer version and silently overwrite it.
        return (try await self.lookup(item.itemIdentifier), conflicted)
      }
    }) { result in
      switch result {
      case .success(let (item, fetchContent)): completionHandler(item, [], fetchContent, nil)
      case .failure(let error): completionHandler(nil, [], false, error)
      }
    }
    return progress
  }

  /// A file edited in another app. Uploaded as a new version, but only on top of
  /// the version it was opened at: if someone else changed it meanwhile, the
  /// edit is kept as a separate "conflicted copy" next to it rather than
  /// overwriting their work, and Files then downloads the newer server version.
  private func uploadEdit(_ source: URL, of file: FileDTO, name: String, type: UTType,
                          baseVersion: NSFileProviderItemVersion, progress: Progress) async throws -> Bool {
    var extra: [String: Any] = ["file_id": file.id]
    if let base = Item.serverVersion(of: baseVersion) { extra["expected_version"] = base }
    do {
      // `name`, not file.name: a rename applied earlier in the same modifyItem
      // has already changed it on the server.
      _ = try await upload(source, name: name, type: type, workspaceId: file.workspace_id ?? "",
                           folderId: file.folder_id, extra: extra, progress: progress)
      return false
    } catch let error as APIError where error.status == 409 && error.code == "version_conflict" {
      let ns = name as NSString
      let ext = ns.pathExtension
      let stem = ext.isEmpty ? name : ns.deletingPathExtension
      let copyName = ext.isEmpty ? "\(stem) (conflicted copy)" : "\(stem) (conflicted copy).\(ext)"
      _ = try await uploadNewFile(source, named: copyName, type: type, workspaceId: file.workspace_id ?? "",
                                  folderId: file.folder_id, progress: progress)
      return true
    }
  }

  // MARK: Delete

  /// Deleting in Finder moves the item to the dosya.dev trash. A SECOND delete of
  /// a trashed item is a permanent purge on the server, and a delete can be sent
  /// twice - the system retries one whose response it never received, and the network
  /// stack may resend it on a dropped connection. So the state is read first,
  /// and `trash_only=1` makes the server refuse to purge even if a resend slips
  /// past that read.
  func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                  options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                  completionHandler: @escaping (Error?) -> Void) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    run(progress, {
      guard let ref = ItemRef(identifier) else { return }
      switch ref {
      case .root, .workspace:
        throw self.unsupported("Workspaces can be deleted only in the dosya.dev app.")
      case .file(let id):
        do {
          let file = try await self.api.get(FileResponse.self, "/api/files/\(id)").file
          guard file.deleted_at == nil else { return }
        } catch let error as APIError where error.status == 404 {
          return
        }
        _ = try await self.api.send("DELETE", "/api/files/\(id)", query: ["trash_only": "1"])
      case .folder(let id):
        let folder: FolderDTO
        do {
          folder = try await self.api.get(FolderResponse.self, "/api/folders/\(id)").folder
        } catch let error as APIError where error.status == 404 {
          return
        }
        guard folder.is_deleted != 1 else { return }
        if !options.contains(.recursive), let ws = folder.workspace_id {
          let listing = try await self.api.get(ListingResponse.self, "/api/files", query: [
            "workspace_id": ws, "folder_id": id, "page": "1", "per_page": "1",
          ])
          if !(listing.folders ?? []).isEmpty || !(listing.files ?? []).isEmpty {
            throw NSFileProviderError(.directoryNotEmpty)
          }
        }
        _ = try await self.api.send("DELETE", "/api/folders/\(id)", query: ["trash_only": "1"])
      }
    }) { result in
      switch result {
      case .success: completionHandler(nil)
      case .failure(let error): completionHandler(error)
      }
    }
    return progress
  }
}
