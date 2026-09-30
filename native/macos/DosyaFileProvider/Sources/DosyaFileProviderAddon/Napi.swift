import CNodeAPI
import Foundation

/// The Node-API glue. Nothing in here knows what the addon is for: it turns
/// Swift values into JS ones and back, and reports a failure the way a
/// napi_callback has to, by raising a JS exception and returning nil.

/// `NAPI_AUTO_LENGTH` is SIZE_MAX, which Swift imports as UInt while every
/// parameter that takes it is Int.
let autoLength = Int(bitPattern: UInt(NAPI_AUTO_LENGTH))

func jsString(_ env: napi_env?, _ value: String) -> napi_value? {
  var out: napi_value?
  guard napi_create_string_utf8(env, value, autoLength, &out) == napi_ok else { return nil }
  return out
}

func jsBool(_ env: napi_env?, _ value: Bool) -> napi_value? {
  var out: napi_value?
  guard napi_get_boolean(env, value, &out) == napi_ok else { return nil }
  return out
}

func jsNull(_ env: napi_env?) -> napi_value? {
  var out: napi_value?
  guard napi_get_null(env, &out) == napi_ok else { return nil }
  return out
}

func jsUndefined(_ env: napi_env?) -> napi_value? {
  var out: napi_value?
  guard napi_get_undefined(env, &out) == napi_ok else { return nil }
  return out
}

/// Builds a JS object from string properties.
func jsObject(_ env: napi_env?, _ fields: [(String, String)]) -> napi_value? {
  var out: napi_value?
  guard napi_create_object(env, &out) == napi_ok else { return nil }
  for (key, value) in fields {
    napi_set_named_property(env, out, key, jsString(env, value))
  }
  return out
}

/// The call's arguments, up to `count`, or [] when it was given none. Trailing
/// arguments the caller omitted are absent rather than nil-padded, so a
/// `first ?? nil` reads "absent" and "explicitly nil" the same way, which is
/// what every caller here wants.
func arguments(_ env: napi_env?, _ info: napi_callback_info?, count: Int) -> [napi_value?] {
  var argc = count
  var argv = [napi_value?](repeating: nil, count: max(count, 1))
  guard napi_get_cb_info(env, info, &argc, &argv, nil, nil) == napi_ok else { return [] }
  return Array(argv.prefix(min(argc, count)))
}

/// A JS string argument as Swift, or nil when it is absent or another type. A
/// number or an object must NOT be coerced: the only string this addon takes is
/// a session payload, and silently stringifying something else would store a
/// value the extension cannot read.
func swiftString(_ env: napi_env?, _ value: napi_value?) -> String? {
  guard let value else { return nil }
  var type = napi_undefined
  guard napi_typeof(env, value, &type) == napi_ok, type == napi_string else { return nil }
  var size = 0
  guard napi_get_value_string_utf8(env, value, nil, 0, &size) == napi_ok else { return nil }
  var buffer = [CChar](repeating: 0, count: size + 1)
  guard napi_get_value_string_utf8(env, value, &buffer, size + 1, &size) == napi_ok else { return nil }
  return String(cString: buffer)
}

/// Raises a JS exception and returns nil, which is how a napi_callback fails.
@discardableResult
func throwError(_ env: napi_env?, _ message: String) -> napi_value? {
  napi_throw_error(env, nil, message)
  return nil
}

/// Attaches `fn` to `exports` under `name`.
func export(_ env: napi_env?, _ exports: napi_value?, _ name: String, _ fn: napi_callback) {
  var value: napi_value?
  guard napi_create_function(env, name, autoLength, fn, nil, &value) == napi_ok else { return }
  napi_set_named_property(env, exports, name, value)
}
