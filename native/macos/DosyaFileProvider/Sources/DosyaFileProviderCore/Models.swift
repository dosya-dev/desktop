import Foundation

// Wire shapes of the dosya.dev REST API, decoded leniently: every field the
// extension can live without is optional, so an older or newer server degrades
// to a missing detail instead of a failed listing.

struct WorkspaceDTO: Decodable {
  let id: String
  let name: String
  let slug: String?
  /// 1 for Vault (end-to-end encrypted) workspaces, which the extension cannot open.
  let e2ee_mode: Int?
  let created_at: Double?
}

struct WorkspacesResponse: Decodable {
  let workspaces: [WorkspaceDTO]
}

struct FolderDTO: Decodable {
  let id: String
  let name: String
  let parent_id: String?
  let workspace_id: String?
  let lock_mode: String?
  let is_deleted: Int?
  let created_at: Double?
  let updated_at: Double?
}

struct FolderResponse: Decodable {
  let folder: FolderDTO
  /// POST /api/folders is find-or-create: 0 means the name already existed and
  /// `folder` is that existing folder.
  let created_count: Int?
}

struct FileDTO: Decodable {
  let id: String
  let name: String
  let size_bytes: Int64?
  let mime_type: String?
  let `extension`: String?
  let folder_id: String?
  let workspace_id: String?
  let lock_mode: String?
  let current_version: Int?
  let created_at: Double?
  let updated_at: Double?
  let deleted_at: Double?
}

struct FileResponse: Decodable {
  let file: FileDTO
}

struct Pagination: Decodable {
  let page: Int
  let total_pages: Int
}

struct ListingResponse: Decodable {
  let folders: [FolderDTO]?
  let files: [FileDTO]?
  let pagination: Pagination?
}

struct DownloadURLResponse: Decodable {
  let url: String?
  let download_url: String?
}

struct SnapshotFolder: Decodable {
  let id: String
  let name: String
  let parent_id: String?
}

struct SnapshotTombstones: Decodable {
  let files: [String]?
  let folders: [String]?
  let truncated: Bool?
}

struct SnapshotResponse: Decodable {
  let files: [FileDTO]?
  let folders: [SnapshotFolder]?
  let nextCursor: String?
  let hasMore: Bool?
  let deleted: SnapshotTombstones?
  /// The folder a folder-confined member's view is rooted at. Folders and files
  /// directly under it belong at the workspace root in Files.
  let root_folder_id: String?
}

struct UploadInitResponse: Decodable {
  struct Resumable: Decodable {
    let part_size: Int
    let total_parts: Int
    let part_upload_url: String
    let complete_url: String
  }
  let session_id: String
  let upload_url: String
  let resumable: Resumable?
}

struct UploadedFile: Decodable {
  let id: String
  let name: String
  let size_bytes: Int64?
  let mime_type: String?
  let version: Int?
  let created_at: Double?
}

struct UploadedFileResponse: Decodable {
  let file: UploadedFile
}

struct TokenResponse: Decodable {
  let access_token: String
  let refresh_token: String
}

struct ErrorBody: Decodable {
  let error: String?
  let error_code: String?
  let current_version: Int?
}

/// Finder cannot hold two siblings with one name: it renames one locally and
/// asks the provider to rename it on the server, which workspaces refuse,
/// forever. So two workspaces called the same thing are told apart before
/// Finder ever sees them, by slug or by the first six characters of the id.
func disambiguateWorkspaceNames(_ list: [WorkspaceDTO]) -> [WorkspaceDTO] {
  var counts: [String: Int] = [:]
  for ws in list { counts[ws.name.lowercased(), default: 0] += 1 }
  return list.map { ws -> WorkspaceDTO in
    guard counts[ws.name.lowercased(), default: 0] > 1 else { return ws }
    let suffix = ws.slug.map { $0.isEmpty ? String(ws.id.prefix(6)) : $0 } ?? String(ws.id.prefix(6))
    return WorkspaceDTO(id: ws.id, name: "\(ws.name) (\(suffix))", slug: ws.slug,
                        e2ee_mode: ws.e2ee_mode, created_at: ws.created_at)
  }
}
