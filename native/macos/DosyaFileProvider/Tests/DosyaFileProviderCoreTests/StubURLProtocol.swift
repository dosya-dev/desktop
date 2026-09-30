import Foundation

/// Intercepts URLSession traffic so the client can be driven without a server.
/// Upload bodies arrive through `httpBodyStream`, which is what URLSession
/// hands a protocol subclass for a streamed or file-backed upload.
final class StubURLProtocol: URLProtocol {
  nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
  nonisolated(unsafe) static var recorded: [(request: URLRequest, body: Data)] = []

  static func reset() {
    handler = nil
    recorded = []
  }

  static func session() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: config)
  }

  static func ok(_ request: URLRequest, _ json: String, status: Int = 200) -> (HTTPURLResponse, Data) {
    (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
     Data(json.utf8))
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    var body = Data()
    if let stream = request.httpBodyStream {
      stream.open()
      var buffer = [UInt8](repeating: 0, count: 64 * 1024)
      while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        body.append(buffer, count: read)
      }
      stream.close()
    } else if let data = request.httpBody {
      body = data
    }
    Self.recorded.append((request, body))

    do {
      guard let handler = Self.handler else { throw URLError(.badServerResponse) }
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}
