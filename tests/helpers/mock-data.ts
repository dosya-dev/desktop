// ── Mock data for E2E tests ───────────────────────────────────────

export const mockUser = {
  id: "user_test_1",
  email: "test@dosya.dev",
  name: "Test User",
  login_method: "email",
  subscription_status: "active",
  cancel_at_period_end: 0,
  avatar_url: null,
  created_at: "2025-01-15T10:00:00Z",
};

export const mockWorkspace = {
  id: "ws_test_1",
  name: "Test Workspace",
  slug: "test-workspace",
  icon_initials: "TW",
  icon_color: "#3B82F6",
  owner_id: "user_test_1",
  created_at: "2025-01-15T10:00:00Z",
};

export const mockFiles = [
  {
    id: "file_1",
    name: "Project Report.pdf",
    kind: "file",
    size_bytes: 1_048_576,
    mime_type: "application/pdf",
    extension: "pdf",
    region: "eu-west",
    uploaded_by: "user_test_1",
    uploader_name: "Test User",
    folder_id: null,
    workspace_id: "ws_test_1",
    is_favourite: 0,
    is_locked: 0,
    is_hidden: 0,
    created_at: "2025-03-01T12:00:00Z",
    updated_at: "2025-03-01T12:00:00Z",
  },
  {
    id: "file_2",
    name: "Photo.png",
    kind: "file",
    size_bytes: 2_097_152,
    mime_type: "image/png",
    extension: "png",
    region: "us-east",
    uploaded_by: "user_test_1",
    uploader_name: "Test User",
    folder_id: null,
    workspace_id: "ws_test_1",
    is_favourite: 0,
    is_locked: 0,
    is_hidden: 0,
    created_at: "2025-03-02T14:00:00Z",
    updated_at: "2025-03-02T14:00:00Z",
  },
  {
    id: "folder_1",
    name: "Documents",
    kind: "folder",
    size_bytes: 0,
    mime_type: null,
    extension: null,
    region: null,
    uploaded_by: "user_test_1",
    uploader_name: "Test User",
    folder_id: null,
    workspace_id: "ws_test_1",
    is_favourite: 0,
    is_locked: 0,
    is_hidden: 0,
    created_at: "2025-02-15T09:00:00Z",
    updated_at: "2025-02-15T09:00:00Z",
  },
];

export const mockActivity = [
  {
    id: "act_1",
    workspace_id: "ws_test_1",
    user_id: "user_test_1",
    user_name: "Test User",
    action: "file.upload",
    resource_type: "file",
    resource_id: "file_1",
    resource_name: "Project Report.pdf",
    created_at: "2025-03-01T12:00:00Z",
  },
  {
    id: "act_2",
    workspace_id: "ws_test_1",
    user_id: "user_test_1",
    user_name: "Test User",
    action: "folder.create",
    resource_type: "folder",
    resource_id: "folder_1",
    resource_name: "Documents",
    created_at: "2025-02-15T09:00:00Z",
  },
];

export const mockShareLinks = [
  {
    id: "share_1",
    file_id: "file_1",
    file_name: "Project Report.pdf",
    token: "abc123",
    is_password_protected: 0,
    expires_at: null,
    download_count: 5,
    created_at: "2025-03-01T12:30:00Z",
    created_by: "user_test_1",
    status: "active",
  },
];

export const mockFileRequests = [
  {
    id: "req_1",
    workspace_id: "ws_test_1",
    created_by: "user_test_1",
    token: "req_abc123",
    recipient_email: "client@example.com",
    expires_at: "2025-04-01T00:00:00Z",
    max_files: 10,
    uploaded_files_count: 3,
    status: "open",
    created_at: "2025-03-15T10:00:00Z",
  },
];

export const mockMembers = [
  {
    id: "member_1",
    user_id: "user_test_1",
    name: "Test User",
    email: "test@dosya.dev",
    role_id: "role_owner",
    role_name: "Owner",
    avatar_url: null,
    joined_at: "2025-01-15T10:00:00Z",
  },
];

export const mockSessions = [
  {
    id: "sess_1",
    device_name: "Chrome on macOS",
    ip_address: "127.0.0.1",
    location: null,
    created_at: "2025-03-01T10:00:00Z",
    last_used_at: "2025-03-20T10:00:00Z",
    is_current: true,
  },
];
