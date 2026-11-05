import Foundation
import Network
import Security

// A small HTTP server on 127.0.0.1 inside the app. It serves the Tandem UI and
// Pyodide, the project files, AI settings, and a proxy that adds the API key
// from the Keychain to AI requests. It implements the same API as the
// reference server ipad/devserver.py.
//
// Every response is cross-origin isolated (COOP/COEP): the page needs that for
// SharedArrayBuffer, which input() and the debugger use to wait.
final class LocalServer {
    static let preferredPorts: [UInt16] = [47831, 47832, 47833, 47834]
    static let pyodideCDN = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/"
    static let placeholderKey = "tandem-proxy-key"

    let store: ProjectStore
    let ai: AISettingsStore
    let token: String
    let selftest: Bool
    private(set) var port: UInt16 = 0
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "tandem.server", attributes: .concurrent)
    private let webRoot: URL
    private let cacheRoot: URL

    static var wallpaperFile: URL {
        let dir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return dir.appendingPathComponent("wallpaper.json")
    }

    var isRunning: Bool {
        if case .ready = listener?.state { return true }
        return false
    }

    init(store: ProjectStore, ai: AISettingsStore, selftest: Bool) throws {
        self.store = store
        self.ai = ai
        self.selftest = selftest
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = Data(bytes).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
        guard let web = Bundle.main.url(forResource: "web", withExtension: nil) else {
            throw APIError(status: 500, message: "The app is missing its web files.")
        }
        webRoot = web
        cacheRoot = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("pyodide", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
    }

    // A fixed port keeps the page's origin (and so its saved layout) the same between launches.
    func start() throws {
        var lastError: Error = APIError(status: 500, message: "No free port.")
        for candidate in Self.preferredPorts {
            do {
                try listen(on: candidate)
                return
            } catch { lastError = error }
        }
        throw lastError
    }

    private func listen(on candidate: UInt16) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: candidate)!)
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        var failure: Error?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let error): failure = error; ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        if ready.wait(timeout: .now() + 3) == .timedOut || failure != nil {
            listener.cancel()
            throw failure ?? APIError(status: 500, message: "The local server didn't start.")
        }
        self.listener = listener
        port = candidate
    }

    // MARK: HTTP

    private struct Request {
        let method: String
        let path: String
        let query: [String: String]
        let rawQuery: String
        let headers: [String: String] // lower-cased names
        let body: Data
    }

    private struct Response {
        var status: Int
        var body: Data
        var contentType: String
        var headers: [String: String] = [:]
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = self.parse(buffer) {
                self.handle(request) { response in self.send(response, on: connection) }
            } else if isComplete || error != nil || buffer.count > 64 * 1024 * 1024 {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }

    private func parse(_ data: Data) -> Request? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let parts = lines.removeFirst().split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = end.upperBound
        guard data.count - (bodyStart - data.startIndex) >= length else { return nil }
        let body = data[bodyStart..<(bodyStart + length)]
        let target = String(parts[1])
        let pieces = target.split(separator: "?", maxSplits: 1).map(String.init)
        let path = pieces[0].removingPercentEncoding ?? pieces[0]
        let rawQuery = pieces.count > 1 ? pieces[1] : ""
        var query: [String: String] = [:]
        for pair in rawQuery.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String($0) }
            if let k = kv.first { query[k] = kv.count > 1 ? kv[1] : "" }
        }
        return Request(method: String(parts[0]), path: path, query: query, rawQuery: rawQuery, headers: headers, body: Data(body))
    }

    private func send(_ response: Response, on connection: NWConnection) {
        let reason = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway"][response.status] ?? "Status"
        var head = "HTTP/1.1 \(response.status) \(reason)\r\n"
        var headers = response.headers
        headers["Content-Type"] = response.contentType
        headers["Content-Length"] = String(response.body.count)
        headers["Connection"] = "close"
        headers["Cross-Origin-Opener-Policy"] = "same-origin"
        headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        headers["Cross-Origin-Resource-Policy"] = "same-origin"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var data = Data(head.utf8)
        data.append(response.body)
        connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func json(_ object: [String: Any], status: Int = 200) -> Response {
        let body = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return Response(status: status, body: body, contentType: "application/json", headers: ["Cache-Control": "no-store"])
    }

    private func error(_ status: Int, _ message: String) -> Response { json(["detail": message], status: status) }

    // MARK: routing

    private func handle(_ request: Request, reply: @escaping (Response) -> Void) {
        let host = (request.headers["host"] ?? "").lowercased()
        guard host == "127.0.0.1:\(port)" || host == "localhost:\(port)" else { return reply(error(403, "Unexpected host")) }
        let protected = request.path.hasPrefix("/api/")
        if protected {
            if let origin = request.headers["origin"], origin != "http://127.0.0.1:\(port)", origin != "http://localhost:\(port)" {
                return reply(error(403, "Origin not allowed"))
            }
            guard let presented = request.headers["x-tandem-token"], presented == token else {
                return reply(error(403, "Missing or wrong session token"))
            }
        }
        if request.path.hasPrefix("/api/ai/proxy/") { return proxy(request, reply: reply) }
        do {
            if protected { return reply(try api(request)) }
            return serveStatic(request, reply: reply)
        } catch let e as APIError {
            reply(error(e.status, e.message))
        } catch {
            reply(self.error(500, error.localizedDescription))
        }
    }

    private func bodyJSON(_ request: Request) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
    }

    private func api(_ r: Request) throws -> Response {
        switch (r.method, r.path) {
        case ("GET", "/api/status"):
            return json(["runtime": ["version": "ipad", "platform": "iPadOS"], "project": ["root": store.current, "name": store.current], "busy": NSNull()])
        case ("GET", "/api/files"):
            return json(["files": store.list()])
        case ("GET", "/api/file"):
            return json(try store.read(r.query["path"] ?? ""))
        case ("PUT", "/api/file"):
            let b = bodyJSON(r)
            return json(try store.write(b["path"] as? String ?? "", text: b["text"] as? String ?? "", baseHash: b["base_hash"] as? String, create: false))
        case ("POST", "/api/file"):
            let b = bodyJSON(r)
            return json(try store.write(b["path"] as? String ?? "", text: b["text"] as? String ?? "", baseHash: nil, create: true))
        case ("POST", "/api/upload"):
            return json(try store.add(r.query["path"] ?? "", data: r.body))
        case ("GET", "/api/raw"):
            return Response(status: 200, body: try store.readRaw(r.query["path"] ?? ""), contentType: "application/octet-stream", headers: ["Cache-Control": "no-store"])
        case ("PUT", "/api/raw"):
            if r.body.count > 20 * 1024 * 1024 { throw APIError(status: 400, message: "File too large.") }
            try store.writeRaw(r.query["path"] ?? "", data: r.body)
            return json(["path": r.query["path"] ?? ""])
        case ("GET", "/api/projects"):
            return json(["projects": store.projects(), "current": store.current, "stored_in": "Files › On My iPad › Tandem"])
        case ("POST", "/api/projects"):
            let b = bodyJSON(r)
            try store.open((b["name"] as? String ?? "").trimmingCharacters(in: .whitespaces), create: (b["create"] as? Bool) ?? false)
            return json(["current": store.current])
        case ("GET", "/api/ai/settings"):
            return json(ai.publicSettings())
        case ("PUT", "/api/ai/settings"):
            return json(try ai.update(bodyJSON(r)))
        case ("GET", "/api/wallpaper"):
            // The person's wallpaper photo, kept in the app (not in the page's storage).
            guard let data = try? Data(contentsOf: Self.wallpaperFile) else { return json([:]) }
            return Response(status: 200, body: data, contentType: "application/json", headers: ["Cache-Control": "no-store"])
        case ("PUT", "/api/wallpaper"):
            if r.body.count > 24 * 1024 * 1024 { throw APIError(status: 400, message: "That image is too large.") }
            guard let image = bodyJSON(r)["image"] as? String, image.hasPrefix("data:image/") else {
                throw APIError(status: 400, message: "That isn't an image.")
            }
            try r.body.write(to: Self.wallpaperFile, options: [.atomic])
            return json(["ok": true])
        case ("POST", "/api/selftest"):
            // CI: the page reports its self-test here (see ipad/selftest.js).
            let docs = store.documents.appendingPathComponent(".selftest.json")
            try r.body.write(to: docs)
            let report = String(data: r.body, encoding: .utf8) ?? ""
            print("TANDEM-SELFTEST " + report)
            return json(["ok": true])
        default:
            return error(404, "Not found")
        }
    }

    // MARK: AI proxy: the page's requests go out with the real key added here.

    private func proxy(_ r: Request, reply: @escaping (Response) -> Void) {
        let rest = String(r.path.dropFirst("/api/ai/proxy/".count))
        let parts = rest.split(separator: "/", maxSplits: 1).map(String.init)
        guard let provider = parts.first, AISettingsStore.providers[provider] != nil else { return reply(error(404, "Unknown provider")) }
        let base = ai.providerConfig(provider).baseURL
        let key = ai.key(provider) ?? ""
        guard let url = URL(string: base + "/" + (parts.count > 1 ? parts[1] : "") + (r.rawQuery.isEmpty ? "" : "?" + r.rawQuery)) else {
            return reply(error(400, "Bad provider address."))
        }
        var out = URLRequest(url: url, timeoutInterval: 300)
        out.httpMethod = r.method
        let skip: Set<String> = ["host", "origin", "referer", "x-tandem-token", "content-length", "connection", "accept-encoding", "cookie"]
        for (k, v) in r.headers where !skip.contains(k) {
            if v.contains(Self.placeholderKey) {
                if key.isEmpty { continue }
                out.setValue(v.replacingOccurrences(of: Self.placeholderKey, with: key), forHTTPHeaderField: k)
            } else {
                out.setValue(v, forHTTPHeaderField: k)
            }
        }
        if ["POST", "PUT", "PATCH"].contains(r.method) { out.httpBody = r.body }
        URLSession.shared.dataTask(with: out) { data, response, err in
            guard let http = response as? HTTPURLResponse else {
                let host = url.host ?? "the provider"
                let why = err?.localizedDescription ?? "no answer"
                return reply(self.error(502, "Couldn't reach \(host) (\(why))."))
            }
            reply(Response(status: http.statusCode, body: data ?? Data(), contentType: http.value(forHTTPHeaderField: "Content-Type") ?? "application/json"))
        }.resume()
    }

    // MARK: static files

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
        "json": "application/json", "wasm": "application/wasm", "svg": "image/svg+xml", "png": "image/png",
        "ttf": "font/ttf", "woff": "font/woff", "woff2": "font/woff2", "zip": "application/zip", "whl": "application/zip",
        "tar": "application/x-tar", "map": "application/json",
    ]

    private func serveStatic(_ r: Request, reply: @escaping (Response) -> Void) {
        let rel = String(r.path.drop(while: { $0 == "/" }))
        if rel.split(separator: "/").contains("..") { return reply(error(404, "Not found")) }
        let file = webRoot.appendingPathComponent(rel)
        var isDir: ObjCBool = false
        if !rel.isEmpty, FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue,
           let data = FileManager.default.contents(atPath: file.path) {
            let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
            return reply(Response(status: 200, body: data, contentType: type, headers: ["Cache-Control": "max-age=3600"]))
        }
        if rel.hasPrefix("pyodide/") { return pyodidePackage(String(rel.dropFirst("pyodide/".count)), reply: reply) }
        if rel.hasPrefix("assets/") { return reply(error(404, "Not found")) }
        // The UI, with this launch's settings for the page.
        guard var html = try? String(contentsOf: webRoot.appendingPathComponent("index.html"), encoding: .utf8) else {
            return reply(error(500, "The app is missing its web files."))
        }
        let config: [String: Any] = ["mode": "local", "platform": "ipad", "token": token, "selftest": selftest]
        let configJSON = String(data: try! JSONSerialization.data(withJSONObject: config), encoding: .utf8)!.replacingOccurrences(of: "</", with: "<\\/")
        html = html.replacingOccurrences(of: "</head>", with: "<script id=\"tandem-runtime\" type=\"application/json\">\(configJSON)</script></head>")
        reply(Response(status: 200, body: Data(html.utf8), contentType: "text/html; charset=utf-8", headers: ["Cache-Control": "no-store"]))
    }

    // Packages beyond the ones in the app (numpy, pandas, matplotlib, scikit-learn...)
    // download once from Pyodide's CDN, then stay in the app's cache.
    private func pyodidePackage(_ name: String, reply: @escaping (Response) -> Void) {
        let safe = name.range(of: "^[A-Za-z0-9_.+-]+\\.(whl|zip|tar)$", options: .regularExpression) != nil
        guard safe else { return reply(error(404, "Not found")) }
        let cached = cacheRoot.appendingPathComponent(name)
        if let data = FileManager.default.contents(atPath: cached.path) {
            return reply(Response(status: 200, body: data, contentType: "application/zip"))
        }
        guard let url = URL(string: Self.pyodideCDN + name) else { return reply(error(404, "Not found")) }
        URLSession.shared.dataTask(with: url) { data, response, _ in
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200 else {
                return reply(self.error(404, "\(name) isn't in Tandem and couldn't be downloaded (are you online?)."))
            }
            try? data.write(to: cached, options: .atomic)
            reply(Response(status: 200, body: data, contentType: "application/zip"))
        }.resume()
    }
}
