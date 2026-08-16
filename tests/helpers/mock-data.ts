// ── Mock data for E2E tests ───────────────────────────────────────

export const mockUser = {
  id: "user_test_1",
  email: "test@dosya.dev",
  name: "Test User",
  login_method: "email",
  subscription_status: "active",
  cancel_at_period_end: 0,
  avatar_url: "/api/me/avatar",
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

export const mockWorkspaceB = {
  ...mockWorkspace,
  id: "ws_2",
  name: "Second Workspace",
  slug: "second-workspace",
  icon_initials: "SW",
};

export const mockFiles = [
  {
    // Real MP3 (tests/fixtures/sample-track.mp3) with ID3v2.3 title/artist/
    // album, embedded cover art and timestamped USLT lyrics, so the audio
    // viewer's tag read, artwork decode and waveform all run against genuine
    // bytes rather than a stub.
    id: "file_audio",
    name: "03 Midnight Ferry.mp3",
    kind: "file",
    size_bytes: 532_672,
    mime_type: "audio/mpeg",
    extension: "mp3",
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
    id: "file_audio_2",
    name: "04 Harbour Static.mp3",
    kind: "file",
    size_bytes: 532_672,
    mime_type: "audio/mpeg",
    extension: "mp3",
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
  // `file_v*` ids get version history from the mock API (see mock-api.ts), so
  // specs can exercise the viewer's version panel. Everything else stays at a
  // single version, which is what the viewer saw before the endpoint existed.
  {
    id: "file_v1",
    name: "Versioned Report.pdf",
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
    id: "file_3",
    name: "Budget.docx",
    kind: "file",
    size_bytes: 524_288,
    mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
    region: "eu-west",
    uploaded_by: "user_test_1",
    uploader_name: "Test User",
    folder_id: null,
    workspace_id: "ws_test_1",
    is_favourite: 0,
    is_locked: 0,
    is_hidden: 0,
    created_at: "2025-03-03T09:00:00Z",
    updated_at: "2025-03-03T09:00:00Z",
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
  // Office preview fixtures. Three files rather than one because the outcomes
  // that matter read differently to a user: converted, still converting, and
  // too large. See tests/e2e/office-preview.spec.ts.
  {
    id: "file_docx", name: "report.docx", kind: "file", size_bytes: 24_576,
    mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx", region: "eu-west", uploaded_by: "user_test_1",
    uploader_name: "Test User", folder_id: null, workspace_id: "ws_test_1",
    is_favourite: 0, is_locked: 0, is_hidden: 0,
    created_at: "2025-03-01T12:00:00Z", updated_at: "2025-03-01T12:00:00Z",
  },
  {
    id: "file_converting", name: "converting.docx", kind: "file", size_bytes: 24_576,
    mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx", region: "eu-west", uploaded_by: "user_test_1",
    uploader_name: "Test User", folder_id: null, workspace_id: "ws_test_1",
    is_favourite: 0, is_locked: 0, is_hidden: 0,
    created_at: "2025-03-01T12:00:00Z", updated_at: "2025-03-01T12:00:00Z",
  },
  {
    id: "file_huge", name: "huge.pptx", kind: "file", size_bytes: 62_914_560,
    mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: "pptx", region: "eu-west", uploaded_by: "user_test_1",
    uploader_name: "Test User", folder_id: null, workspace_id: "ws_test_1",
    is_favourite: 0, is_locked: 0, is_hidden: 0,
    created_at: "2025-03-01T12:00:00Z", updated_at: "2025-03-01T12:00:00Z",
  },
  {
    id: "file_book", name: "The Dosya Test Book.epub", folder_id: null,
    size_bytes: 1699, mime_type: "application/epub+zip", extension: ".epub",
    created_at: "2025-03-01T12:00:00Z", updated_at: "2025-03-01T12:00:00Z",
    uploaded_by: "user_test_1", uploader_name: "Test User", region: "apac",
    current_version: 1, lock_mode: "none", is_hidden: 0, is_synced: 0,
    share_count: 0, comment_count: 0, origin: null,
  },];

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

/**
 * Shaped like what GET /api/file-requests actually returns.
 *
 * The old fixture carried recipient_email, uploaded_files_count, status and ISO
 * date strings - none of which the endpoint sends. That is why the page's
 * recipient_email line looked fine here while being permanently invisible in
 * production: the mock supplied a field the API does not.
 */
export const mockFileRequests = [
  {
    id: "req_1",
    token: "req_abc123",
    title: "Client brand assets",
    message: "Logos and typefaces please.",
    is_password_protected: 0,
    expires_at: null,
    allowed_extensions: null,
    max_file_size_bytes: null,
    max_files: 10,
    upload_count: 3,
    is_revoked: 0,
    created_at: 1_740_000_000,
    folder_id: null,
    created_by_name: "Test User",
    folder_name: null,
    url: "https://dosya.dev/upload-request/req_abc123",
  },
  {
    id: "req_2",
    token: "req_closed",
    title: "Last quarter's invoices",
    message: null,
    is_password_protected: 1,
    expires_at: null,
    allowed_extensions: "pdf",
    max_file_size_bytes: 10 * 1024 * 1024,
    max_files: null,
    upload_count: 0,
    is_revoked: 1,
    created_at: 1_739_000_000,
    folder_id: "folder_1",
    created_by_name: "Test User",
    folder_name: "Documents",
    url: "https://dosya.dev/upload-request/req_closed",
  },
];

export const mockRequestRecipients = [
  {
    id: "rcp_1", email: "client@example.com", token: "rt_1",
    sent_at: 1_740_000_100, uploaded_at: null, created_at: 1_740_000_050,
  },
  {
    id: "rcp_2", email: "done@example.com", token: "rt_2",
    sent_at: 1_740_000_100, uploaded_at: 1_740_000_500, created_at: 1_740_000_050,
  },
];

export const mockRequestUploads = [
  {
    id: "fru_1", file_id: "file_1", uploader_email: "client@example.com",
    uploader_name: "Client", created_at: 1_740_000_600,
    file_name: "logo.png", size_bytes: 2048,
    mime_type: "image/png", extension: ".png",
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

/** Two rows, one unread and one read, so the badge and the dot are both testable. */
export const mockNotifications = [
  {
    id: "ntf_unread", kind: "personal", type: "files_uploaded", category: "files",
    priority: "normal", title: "report.pdf was uploaded", body: "Added to Invoices",
    icon: null, link_path: "/files/file_1", actions: null, actor_name: "Ada",
    created_at: Math.floor(Date.now() / 1000) - 120, read_at: null, dismissed_at: null,
  },
  {
    id: "ntf_read", kind: "personal", type: "files_share_expiring", category: "files",
    priority: "normal", title: "A share link expires tomorrow", body: null,
    icon: null, link_path: "/vault", actions: null, actor_name: null,
    created_at: Math.floor(Date.now() / 1000) - 7200, read_at: Math.floor(Date.now() / 1000) - 60,
    dismissed_at: null,
  },
];

/**
 * GET /api/me/notifications, as the server answers it since the preference
 * groups shipped: the settings screen described by the server rather than
 * hard-coded by each client.
 *
 * Transcribed from apps/api's GROUP_LABELS and spec §3.4. The point of the
 * fixture is that the RENDERER holds no copy of this list - if it did, a
 * fixture with different labels would still render the client's own.
 */
export const mockNotificationGroups = [
  { key: "security", label: "Security and sign-in", description: "New device sign-ins, failed attempts, password, email and two-factor changes.", alwaysOn: "some" as const },
  { key: "account", label: "Account", description: "Account and workspace deletion, ownership transfers, workspace settings.", alwaysOn: "some" as const },
  { key: "team", label: "Team and permissions", description: "Invitations, members joining and leaving, role and permission changes.", alwaysOn: "some" as const },
  { key: "billing", label: "Billing and storage", description: "Payment problems, plan changes, renewals and storage limits.", alwaysOn: "some" as const },
  { key: "files", label: "File activity", description: "Uploads, deletions, new versions and locks on files you own.", alwaysOn: "none" as const },
  { key: "sharing", label: "Share links", description: "Views, downloads and expiry of links you created.", alwaysOn: "some" as const },
  { key: "requests", label: "File requests", description: "Uploads to your requests, and deadlines approaching.", alwaysOn: "none" as const },
  { key: "comments", label: "Comments", description: "New comments and replies on your files.", alwaysOn: "none" as const },
  { key: "sync", label: "Sync and backup", description: "Sync failures, stopped devices, conflicts and phone backup.", alwaysOn: "some" as const },
  { key: "transfers", label: "Imports and transfers", description: "Cloud imports, remote downloads and connection problems.", alwaysOn: "none" as const },
  { key: "integrations", label: "Integrations and API", description: "API keys, S3 credentials and webhook endpoint health.", alwaysOn: "some" as const },
  { key: "support", label: "Support and legal", description: "Replies to your tickets, and copyright or moderation actions.", alwaysOn: "some" as const },
  { key: "product", label: "Product updates", description: "New features, improvements and tips.", alwaysOn: "none" as const },
  { key: "system", label: "System", description: "Scheduled maintenance and service incidents.", alwaysOn: "none" as const },
].map((g) => ({
  ...g,
  enabled: true,
  note: g.alwaysOn === "some" ? "Some messages in this group are always sent and cannot be switched off." : null,
  options: g.key === "files"
    ? [
      { key: "type:files_uploaded", label: "Uploads to your workspace", description: "One summary per folder per hour when other people add files. Off unless you ask for it.", enabled: false },
      { key: "type:files_activity_digest", label: "Daily activity summary", description: "One message each morning counting yesterday's renames and moves. Off unless you ask for it.", enabled: false },
    ]
    : [],
}));

/**
 * Three comments that make the comments tab's three behaviours visible: one this
 * user wrote (edit is offered), one somebody else wrote (edit is not), and one at
 * depth two, which the old grouping dropped on the floor.
 */
export const mockComments = [
  {
    id: "cmt_1", file_id: "file_1", folder_id: null, workspace_id: "ws_test_1",
    user_id: "user_test_1", parent_id: null, body: "First pass looks good.",
    is_edited: 0, created_at: 1_740_000_000, updated_at: 1_740_000_000,
    user_name: "Test User", user_email: "test@example.com", user_avatar: null,
  },
  {
    id: "cmt_2", file_id: "file_1", folder_id: null, workspace_id: "ws_test_1",
    user_id: "user_other", parent_id: "cmt_1", body: "Agreed, shipping it.",
    is_edited: 0, created_at: 1_740_000_100, updated_at: 1_740_000_100,
    user_name: "Grace Hopper", user_email: "grace@example.com", user_avatar: null,
  },
  {
    id: "cmt_3", file_id: "file_1", folder_id: null, workspace_id: "ws_test_1",
    user_id: "user_test_1", parent_id: "cmt_2", body: "One more thing.",
    is_edited: 0, created_at: 1_740_000_200, updated_at: 1_740_000_200,
    user_name: "Test User", user_email: "test@example.com", user_avatar: null,
  },
];

/** Two groups: one with items of both kinds, one empty. */
export const mockGroups = [
  {
    id: "grp_1", name: "Client work", color: "#706E69", sort_order: 0, created_at: 1_740_000_000,
    folders: [{ item_id: "gfi_1", folder_id: "folder_1", folder_name: "Documents", parent_id: null }],
    files: [{ item_id: "gf_1", file_id: "file_1", file_name: "Project Report.pdf", size_bytes: 1_048_576, extension: ".pdf", folder_id: null }],
  },
  {
    id: "grp_2", name: "Reading list", color: "#1D4ED8", sort_order: 1, created_at: 1_739_000_000,
    folders: [], files: [],
  },
];

/**
 * Two duplicate groups, newest-first inside each (the API sorts created_at DESC).
 * dup_hash_a has three copies so "select all but newest" has something to leave.
 */
export const mockDuplicates = {
  groups: [
    {
      content_hash: "hash_a", size_bytes: 1_048_576, count: 3, wasted_bytes: 2_097_152,
      files: [
        { id: "dupfile_1", name: "Photo.png", folder_id: null, folder_path: "Workspace root", created_at: 1_740_000_300, uploaded_by: "user_test_1", uploader_name: "Test User", mime_type: "image/png", extension: ".png" },
        { id: "dupfile_2", name: "Photo.png", folder_id: "folder_1", folder_path: "Documents", created_at: 1_740_000_200, uploaded_by: "user_test_1", uploader_name: "Test User", mime_type: "image/png", extension: ".png" },
        { id: "dupfile_3", name: "Photo.png", folder_id: "folder_1", folder_path: "Documents/Old", created_at: 1_740_000_100, uploaded_by: "user_test_1", uploader_name: "Test User", mime_type: "image/png", extension: ".png" },
      ],
    },
    {
      content_hash: "hash_b", size_bytes: 512_000, count: 2, wasted_bytes: 512_000,
      files: [
        { id: "dupfile_4", name: "Budget.docx", folder_id: null, folder_path: "Workspace root", created_at: 1_739_000_200, uploaded_by: "user_test_1", uploader_name: "Test User", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" },
        { id: "dupfile_5", name: "Budget.docx", folder_id: "folder_1", folder_path: "Documents", created_at: 1_739_000_100, uploaded_by: "user_test_1", uploader_name: "Test User", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" },
      ],
    },
  ],
  total_groups: 2,
  total_wasted_bytes: 2_609_152,
  scanning: { pending: 0 },
};

/**
 * Two located files and one located folder, spread far enough apart that the map
 * has to fit real bounds rather than centring on a single point.
 */
export const mockMapPins = [
  { kind: "file", id: "file_1", name: "Photo.png", size_bytes: 2_097_152, mime_type: "image/png", extension: ".png", region: "apac", created_at: 1_740_000_000, updated_at: 1_740_000_000, current_version: 1, lock_mode: "none", is_hidden: 0, uploaded_by: "user_test_1", uploader_name: "Test User", share_count: 0, comment_count: 0, is_synced: 0, latitude: -33.8688, longitude: 151.2093, captured_at: null, source: "exif" },
  { kind: "file", id: "file_2", name: "Harbour.jpg", size_bytes: 1_048_576, mime_type: "image/jpeg", extension: ".jpg", region: "apac", created_at: 1_740_000_100, updated_at: 1_740_000_100, current_version: 1, lock_mode: "none", is_hidden: 0, uploaded_by: "user_test_1", uploader_name: "Test User", share_count: 0, comment_count: 0, is_synced: 0, latitude: 51.5074, longitude: -0.1278, captured_at: null, source: "exif" },
  { kind: "folder", id: "folder_1", name: "Documents", latitude: 40.7128, longitude: -74.006, source: "ip" },
];
