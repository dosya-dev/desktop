import CNodeAPI
import Foundation

/// The native side of the app's Finder integration, loaded into the Electron
/// main process as a Node addon.
///
/// It has to be in-process. Writing the session needs the
/// `keychain-access-groups` entitlement, and only code the app's own embedded
/// provisioning profile authorizes may claim it: a helper tool in
/// Contents/MacOS is killed at launch, and a nested bundle would need a
/// provisioning profile, and so an App ID, of its own. Registering the domain
/// has to come from the extension's containing app, which is this process too.
///
/// Session.swift is compiled in rather than restated, so the keychain contract
/// is one definition shared with the extension.

/// The Finder location's identity. Unlike the keychain names these are not
/// shared with the extension, because only the app registers the domain.
/// `displayName` is what Finder shows under Locations and what names the folder
/// under ~/Library/CloudStorage; the packaging test pins both so a change is
/// deliberate rather than a rename that moves everyone's files.
enum DomainConstants {
  static let identifier = "dosya"
  static let displayName = "dosya.dev"
}

/// macOS 12 is the floor for the replicated File Provider API the extension is
/// built against, and the app's own minimum. Below it the app still runs and
/// simply never offers a Finder location.
private let isSupportedCallback: napi_callback = { env, _ in
  if #available(macOS 12.0, *) { return jsBool(env, true) }
  return jsBool(env, false)
}

/// Every name the app and the extension must agree on, reported from the Swift
/// they both compile so a test can compare them with the declarations.
private let contractCallback: napi_callback = { env, _ in
  jsObject(env, [
    ("service", SharedConstants.keychainService),
    ("account", SharedConstants.keychainAccount),
    ("accessGroup", SharedConstants.accessGroupSuffix),
    ("domainIdentifier", DomainConstants.identifier),
    ("domainDisplayName", DomainConstants.displayName),
  ])
}

/// One store for the process. Resolving the entitled access group walks this
/// process's own signature, which is worth doing once.
private let store = KeychainSessionStore()

/// The stored session's owner, or null. Never the tokens: the only question JS
/// asks is whose session this is, and handing them out would put a bearer
/// credential in the renderer's reach for no reason.
private let storedUserIdCallback: napi_callback = { env, _ in
  guard let userId = store.load()?.userId else { return jsNull(env) }
  return jsString(env, userId)
}

/// `json` is `{access, refresh, apiBaseUrl, userId}`. Decoded here rather than
/// stored as it arrived: a payload the extension cannot read would leave Finder
/// asking to sign in forever, and this is the last place that can refuse it.
private let writeSessionCallback: napi_callback = { env, info in
  guard let json = swiftString(env, arguments(env, info, count: 1).first ?? nil) else {
    return throwError(env, "writeSession needs the session as a JSON string")
  }
  guard let data = json.data(using: .utf8),
        let session = try? JSONDecoder().decode(LinkedSession.self, from: data)
  else {
    return throwError(env, "writeSession was given JSON the extension cannot read")
  }
  guard store.save(session) else {
    return throwError(env, "writeSession could not reach the shared keychain")
  }
  return jsUndefined(env)
}

private let clearSessionCallback: napi_callback = { env, _ in
  store.clear()
  return jsUndefined(env)
}

@_cdecl("napi_register_module_v1")
public func registerModule(_ env: napi_env?, _ exports: napi_value?) -> napi_value? {
  export(env, exports, "isSupported", isSupportedCallback)
  export(env, exports, "contract", contractCallback)
  export(env, exports, "storedUserId", storedUserIdCallback)
  export(env, exports, "writeSession", writeSessionCallback)
  export(env, exports, "clearSession", clearSessionCallback)
  export(env, exports, "registerDomain", registerDomainCallback)
  export(env, exports, "removeDomain", removeDomainCallback)
  export(env, exports, "signalChanges", signalChangesCallback)
  export(env, exports, "domainEnabled", domainEnabledCallback)
  return exports
}
