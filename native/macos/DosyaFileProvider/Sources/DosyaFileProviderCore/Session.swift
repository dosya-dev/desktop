import Foundation
import Security

/// The contract the Electron app must write to. Every value here is part of it:
/// change one and the app and the extension stop seeing the same item, which
/// builds and runs fine and leaves Finder asking to sign in forever.
///
/// - keychain: the DATA PROTECTION keychain, not the legacy file-based one.
///   On macOS `kSecAttrAccessGroup` and `kSecAttrAccessible` are honoured only
///   when `kSecUseDataProtectionKeychain` is set (SecItem.h, "kSecClassGenericPassword
///   item attributes"). Sharing by access group is a data protection keychain
///   feature, so without that flag the two processes address different stores.
///   This rules out any writer that uses the legacy keychain, which includes
///   Electron's safeStorage and keytar.
/// - service / account: the names below.
/// - value: UTF-8 JSON with the default `JSONEncoder` keys of `LinkedSession`,
///   that is `{"access","refresh","apiBaseUrl"}` plus an optional `"userId"`.
public enum SharedConstants {
  /// The access group WITHOUT a team prefix. On macOS outside the App Store the
  /// entitlement value carries one, so the prefix is resolved at runtime from
  /// this process's own entitlements rather than hard-coded here: a literal
  /// would break the moment the team changes, and nothing later in the build
  /// can fill it in.
  public static let accessGroupSuffix = "group.dev.dosya.desktop"
  public static let keychainService = "dev.dosya.desktop.files-provider"
  public static let keychainAccount = "linked-session"

  /// The entitled keychain access group ending in `accessGroupSuffix`, for
  /// example "ABCDE12345.group.dev.dosya.desktop". Nil when this process has no
  /// such entitlement, which is every unit test and any unsigned build.
  public static func resolvedAccessGroup() -> String? {
    guard let task = SecTaskCreateFromSelf(nil),
          let raw = SecTaskCopyValueForEntitlement(task, "keychain-access-groups" as CFString, nil),
          let groups = raw as? [String]
    else { return nil }
    return groups.first { $0 == accessGroupSuffix || $0.hasSuffix("." + accessGroupSuffix) }
  }
}

/// The extension's own session, minted by the app through
/// POST /api/auth/desktop/linked-session (migration 0185). It is a mobile token
/// row, so it refreshes against /api/auth/mobile/refresh, and it dies when the
/// desktop session that minted it is signed out or revoked.
public struct LinkedSession: Codable, Equatable {
  public var access: String
  public var refresh: String
  public var apiBaseUrl: String
  /// Optional on purpose: the mint route does not return a user id, so a writer
  /// that omits it must not produce a payload this side reads as "signed out".
  public var userId: String?

  public init(access: String, refresh: String, apiBaseUrl: String, userId: String? = nil) {
    self.access = access
    self.refresh = refresh
    self.apiBaseUrl = apiBaseUrl
    self.userId = userId
  }
}

/// Behind a protocol so the tests never touch the real keychain: an access
/// group needs an entitlement, an entitlement needs a provisioning profile, and
/// a unit test has neither.
public protocol SessionStore: Sendable {
  func load() -> LinkedSession?
  /// Reports whether the write landed. A rotation that cannot be stored leaves
  /// the keychain holding a refresh token the server has already replaced, so
  /// the caller has to know rather than find out after the next launch.
  @discardableResult func save(_ session: LinkedSession) -> Bool
  func clear()
}

public final class MemorySessionStore: SessionStore, @unchecked Sendable {
  private let lock = NSLock()
  private var current: LinkedSession?
  /// How many times `clear()` ran, so a test can assert "exactly once".
  public private(set) var clears = 0

  public init(_ current: LinkedSession? = nil) { self.current = current }

  public func load() -> LinkedSession? {
    lock.lock(); defer { lock.unlock() }
    return current
  }

  @discardableResult public func save(_ session: LinkedSession) -> Bool {
    lock.lock(); defer { lock.unlock() }
    current = session
    return true
  }

  public func clear() {
    lock.lock(); defer { lock.unlock() }
    current = nil
    clears += 1
  }
}

public final class KeychainSessionStore: SessionStore, @unchecked Sendable {
  private let accessGroup: String?

  /// `accessGroup` defaults to whatever this process is entitled to. Passing one
  /// explicitly is for diagnostics only.
  public init(accessGroup: String? = SharedConstants.resolvedAccessGroup()) {
    self.accessGroup = accessGroup
  }

  private var baseQuery: [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: SharedConstants.keychainService,
      kSecAttrAccount as String: SharedConstants.keychainAccount,
      // Without this the rest of the query addresses the legacy keychain, where
      // the access group and the accessibility class are both ignored.
      kSecUseDataProtectionKeychain as String: true,
    ]
    // Omitted when unresolved: a query with no group searches every group this
    // process is entitled to, which is what an unsigned or test build wants.
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }

  public func load() -> LinkedSession? {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    guard status == errSecSuccess, let data = out as? Data else {
      if status != errSecItemNotFound {
        NSLog("dosya file provider: keychain read failed (%d)", status)
      }
      return nil
    }
    guard let session = try? JSONDecoder().decode(LinkedSession.self, from: data) else {
      NSLog("dosya file provider: keychain holds a payload this build cannot read")
      return nil
    }
    return session
  }

  @discardableResult public func save(_ session: LinkedSession) -> Bool {
    guard let data = try? JSONEncoder().encode(session) else { return false }
    let update: [String: Any] = [
      kSecValueData as String: data,
      // Readable while the Mac is locked, so a transfer in progress survives the
      // screen locking, and never restored onto another machine.
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var add = baseQuery
      add.merge(update) { _, new in new }
      status = SecItemAdd(add as CFDictionary, nil)
    }
    if status != errSecSuccess {
      NSLog("dosya file provider: keychain write failed (%d)", status)
      return false
    }
    return true
  }

  public func clear() {
    let status = SecItemDelete(baseQuery as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound {
      NSLog("dosya file provider: keychain delete failed (%d)", status)
    }
  }
}
