import Citadel
import Crypto
import Foundation
import NIOCore
import NIOSSH

// Tandem on an SSH server, from the iPad (the same as the desktop app's
// desktop/ssh/session.js): sign in with a password or a private key, check
// the server's host key (confirmed the first time, refused if it changes),
// install Tandem's runtime on the server the first time (the bundled
// runtime/remote/bootstrap.sh and the runtime, sent through shell commands,
// so the server needs no SFTP), start it for one folder, and
// open tunnels to it for LocalServer, which shows the app's own UI and passes
// the API and WebSocket through. The runtime on the server listens on its
// 127.0.0.1 only and stops when this connection closes.

struct SSHServer: Codable, Identifiable, Equatable {
    var host: String
    var port: Int
    var username: String
    var folder: String
    var auth: String // "password" or "key"

    var id: String { "\(username)@\(host.lowercased()):\(port)" }
    var label: String { "\(username)@\(host)\(port == 22 ? "" : ":\(port)")" }
}

enum SSHAuthInput {
    case password(String)
    case key(text: String, passphrase: String?)
}

struct SSHFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct HostKeyInfo: Identifiable {
    let host: String
    let port: Int
    let type: String
    let fingerprint: String
    var id: String { fingerprint }
}

// Servers' host keys seen before (like known_hosts), in Application Support.
final class KnownHosts {
    private let file: URL

    init() {
        let dir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        file = dir.appendingPathComponent("ssh-known-hosts.json")
    }

    private func read() -> [String: [String: String]] {
        guard let data = try? Data(contentsOf: file),
              let all = try? JSONSerialization.jsonObject(with: data) as? [String: [String: String]] else { return [:] }
        return all
    }

    private func key(_ host: String, _ port: Int) -> String { "\(host.lowercased()):\(port)" }

    func lookup(_ host: String, _ port: Int) -> String? { read()[key(host, port)]?["fingerprint"] }

    func remember(_ info: HostKeyInfo) {
        var all = read()
        all[key(info.host, info.port)] = ["type": info.type, "fingerprint": info.fingerprint]
        if let data = try? JSONSerialization.data(withJSONObject: all) { try? data.write(to: file, options: .atomic) }
    }

    func forget(_ host: String, _ port: Int) {
        var all = read()
        all.removeValue(forKey: key(host, port))
        if let data = try? JSONSerialization.data(withJSONObject: all) { try? data.write(to: file, options: .atomic) }
    }
}

// SHA256:<base64>, as OpenSSH shows a host key.
func sshFingerprint(_ key: NIOSSHPublicKey) -> (type: String, fingerprint: String) {
    let text = String(openSSHPublicKey: key)
    let parts = text.split(separator: " ")
    let type = parts.first.map(String.init) ?? "unknown"
    let blob = parts.count > 1 ? (Data(base64Encoded: String(parts[1])) ?? Data()) : Data()
    let digest = Data(SHA256.hash(data: blob)).base64EncodedString().replacingOccurrences(of: "=", with: "")
    return (type, "SHA256:\(digest)")
}

final class HostKeyCheck: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    let host: String
    let port: Int
    let known: KnownHosts
    let confirm: (HostKeyInfo) async -> Bool
    var refusal: SSHFailure?

    init(host: String, port: Int, known: KnownHosts, confirm: @escaping (HostKeyInfo) async -> Bool) {
        self.host = host
        self.port = port
        self.known = known
        self.confirm = confirm
    }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let (type, fingerprint) = sshFingerprint(hostKey)
        let info = HostKeyInfo(host: host, port: port, type: type, fingerprint: fingerprint)
        if let previous = known.lookup(host, port) {
            if previous == fingerprint { return validationCompletePromise.succeed(()) }
            refusal = SSHFailure(message: "The server's identity changed. \(host) now shows the key \(fingerprint), not the \(previous) Tandem saw before. That can mean someone is intercepting the connection. Tandem didn't connect. If the server was reinstalled, ask its admin to confirm the new key, then forget the server in Tandem and connect again.")
            return validationCompletePromise.fail(refusal!)
        }
        Task {
            if await confirm(info) {
                known.remember(info)
                validationCompletePromise.succeed(())
            } else {
                refusal = SSHFailure(message: "Not connected: the server's identity wasn't confirmed.")
                validationCompletePromise.fail(refusal!)
            }
        }
    }
}

// Resumes a continuation exactly once.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var done = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

// One tunnel to the runtime on the server (an HTTP request or the WebSocket).
final class SSHTunnel {
    private let channel: Channel

    init(channel: Channel) { self.channel = channel }

    func write(_ data: Data) {
        channel.writeAndFlush(NIOAny(ByteBuffer(bytes: data)), promise: nil)
    }

    func close() { channel.close(promise: nil) }
}

private final class TunnelInbound: ChannelInboundHandler {
    typealias InboundIn = ByteBuffer
    let onData: (Data) -> Void
    let onClose: () -> Void

    init(onData: @escaping (Data) -> Void, onClose: @escaping () -> Void) {
        self.onData = onData
        self.onClose = onClose
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let buffer = unwrapInboundIn(data)
        onData(Data(buffer.readableBytesView))
    }

    func channelInactive(context: ChannelHandlerContext) {
        onClose()
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        context.close(promise: nil)
    }
}

final class SSHSession: @unchecked Sendable {
    let server: SSHServer
    let remotePort: Int
    let token: String
    private let client: SSHClient
    private var serveTask: Task<Void, Never>?
    private var closed = false
    var onLost: (() -> Void)?

    private init(server: SSHServer, client: SSHClient, remotePort: Int, token: String) {
        self.server = server
        self.client = client
        self.remotePort = remotePort
        self.token = token
    }

    // The files Tandem installs on servers, bundled with the app.
    private struct RemoteFiles {
        let bootstrap: Data
        let constraints: Data
        let lite: Data
        let wheel: Data
        let wheelName: String
        let id: String
    }

    private static func remoteFiles() throws -> RemoteFiles {
        guard let dir = Bundle.main.url(forResource: "remote", withExtension: nil),
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path),
              let wheelName = names.first(where: { $0.hasPrefix("tandem_runtime-") && $0.hasSuffix(".whl") }),
              let bootstrap = try? Data(contentsOf: dir.appendingPathComponent("bootstrap.sh")),
              let constraints = try? Data(contentsOf: dir.appendingPathComponent("constraints.txt")),
              let lite = try? Data(contentsOf: dir.appendingPathComponent("lite.py")),
              let wheel = try? Data(contentsOf: dir.appendingPathComponent(wheelName)) else {
            throw SSHFailure(message: "This copy of Tandem is missing the files it installs on servers.")
        }
        var hash = SHA256()
        hash.update(data: wheel)
        hash.update(data: constraints)
        hash.update(data: bootstrap)
        hash.update(data: lite)
        let id = hash.finalize().map { String(format: "%02x", $0) }.joined().prefix(16)
        return RemoteFiles(bootstrap: bootstrap, constraints: constraints, lite: lite, wheel: wheel, wheelName: wheelName, id: String(id))
    }

    private static func authentication(_ auth: SSHAuthInput, username: String) throws -> SSHAuthenticationMethod {
        switch auth {
        case .password(let password):
            return .passwordBased(username: username, password: password)
        case .key(let text, let passphrase):
            let secret = passphrase.flatMap { $0.isEmpty ? nil : Data($0.utf8) }
            if let key = try? Curve25519.Signing.PrivateKey(sshEd25519: text, decryptionKey: secret) {
                return .ed25519(username: username, privateKey: key)
            }
            if let key = try? Insecure.RSA.PrivateKey(sshRsa: text, decryptionKey: secret) {
                return .rsa(username: username, privateKey: key)
            }
            throw SSHFailure(message: text.contains("ENCRYPTED") || secret != nil
                ? "Tandem couldn't open that key: check its passphrase."
                : "Tandem couldn't read that private key. On iPad it takes ed25519 and RSA keys in OpenSSH format.")
        }
    }

    // stdout of a command and whether it exited with 0.
    private func run(_ command: String, onLine: ((String) -> Void)? = nil) async throws -> (out: String, ok: Bool) {
        var out = ""
        var partial = ""
        var ok = true
        do {
            for try await chunk in try await client.executeCommandStream(command) {
                if case .stdout(let buffer) = chunk {
                    let text = String(buffer: buffer)
                    out += text
                    if let onLine {
                        let lines = (partial + text).components(separatedBy: "\n")
                        partial = lines.last ?? ""
                        lines.dropLast().forEach(onLine)
                    }
                }
            }
        } catch is SSHClient.CommandFailed {
            ok = false
        }
        return (out, ok)
    }

    // Writes a file in the home folder on the server through shell commands
    // (not SFTP, which some servers don't offer): base64 in chunks well under
    // the servers' command-length limits, decoded there, then its size checked.
    // path: relative to the home folder, letters, digits and . _ / - only.
    private func upload(_ data: Data, to path: String) async throws {
        let target = "\"$HOME/\(path)\""
        let staged = "\"$HOME/\(path).b64\""
        let text = data.base64EncodedString()
        let chunk = 48 * 1024
        var start = text.startIndex
        var first = true
        repeat {
            let end = text.index(start, offsetBy: chunk, limitedBy: text.endIndex) ?? text.endIndex
            // The base64 alphabet has no quotes, so the chunk is safe inside '…'.
            let written = try await run("printf '%s' '\(text[start..<end])' \(first ? ">" : ">>") \(staged)")
            guard written.ok else { throw SSHFailure(message: "Tandem couldn't write to ~/.tandem on the server (is the disk full?).") }
            first = false
            start = end
        } while start < text.endIndex
        let decoded = try await run("{ base64 -d < \(staged) > \(target) 2>/dev/null || base64 -D < \(staged) > \(target); } && rm -f \(staged) && wc -c < \(target)")
        guard decoded.ok, Int(decoded.out.trimmingCharacters(in: .whitespacesAndNewlines)) == data.count else {
            throw SSHFailure(message: "Tandem couldn't copy its files to the server (\(path.split(separator: "/").last ?? "")).")
        }
    }

    static func connect(server: SSHServer, auth: SSHAuthInput, known: KnownHosts,
                        confirm: @escaping (HostKeyInfo) async -> Bool,
                        progress: @escaping (String) -> Void,
                        fullTools: Bool = false,
                        onClient: @escaping (SSHClient) -> Void = { _ in }) async throws -> SSHSession {
        let files = try remoteFiles()
        progress("Connecting to \(server.label)…")
        let check = HostKeyCheck(host: server.host, port: server.port, known: known, confirm: confirm)
        let client: SSHClient
        do {
            client = try await SSHClient.connect(
                host: server.host,
                port: server.port,
                authenticationMethod: try authentication(auth, username: server.username),
                hostKeyValidator: .custom(check),
                reconnect: .never
            )
        } catch let failure as SSHFailure {
            throw failure
        } catch {
            if let refusal = check.refusal { throw refusal }
            let text = String(describing: error)
            if text.contains("authentication") || text.contains("Authentication") || text.contains("allAuthenticationOptionsFailed") {
                throw SSHFailure(message: "The server refused the sign-in. Check the username and the password or key.")
            }
            throw SSHFailure(message: "Couldn't connect to \(server.host) on port \(server.port) (\(error.localizedDescription)).")
        }

        // Cancel closes this connection while Tandem is set up on the server.
        onClient(client)
        let session = SSHSession(server: server, client: client, remotePort: 0, token: "")
        do {
            try Task.checkCancellation()
            return try await session.start(files: files, fullTools: fullTools, progress: progress)
        } catch {
            try? await client.close()
            throw error
        }
    }

    // fullTools: install Tandem's full runtime if it isn't there (notebooks, the
    // debugger). Otherwise, unless it's already installed, the server's own
    // python3 runs lite.py (files, the Terminal and Run): nothing is installed.
    private func start(files: RemoteFiles, fullTools: Bool, progress: @escaping (String) -> Void) async throws -> SSHSession {
        let dir = ".tandem/remote/\(files.id)"
        progress("Checking the server…")
        _ = try await run("mkdir -p ~/\(dir)")
        try await upload(files.bootstrap, to: "\(dir)/bootstrap.sh")
        try await upload(files.lite, to: "\(dir)/lite.py")
        let check = try await run("sh ~/\(dir)/bootstrap.sh check \(files.id)")
        guard let line = check.out.components(separatedBy: "\n").first(where: { $0.hasPrefix("tandem-check ") }) else {
            throw SSHFailure(message: "The server didn't answer as expected. Is it Linux or macOS with a POSIX shell?")
        }
        var facts: [String: String] = [:]
        for pair in line.dropFirst("tandem-check ".count).split(separator: " ") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { facts[kv[0]] = kv[1] }
        }
        guard ["Linux", "Darwin"].contains(facts["os"] ?? "") else {
            throw SSHFailure(message: "Tandem runs projects on Linux and macOS servers (this one is \(facts["os"] ?? "unknown")).")
        }
        if facts["installed"] != "1" && fullTools {
            progress("Installing Tandem on the server (the first time takes a minute)…")
            try Task.checkCancellation()
            try await upload(files.wheel, to: "\(dir)/\(files.wheelName)")
            try await upload(files.constraints, to: "\(dir)/constraints.txt")
            try Task.checkCancellation()
            // The server says what it's doing every couple of seconds (what's
            // downloaded, how long it has taken), e.g. "Downloading uv (3.2 of 17.2 MB)".
            let install = try await run("sh ~/\(dir)/bootstrap.sh install \(files.id)") { line in
                guard line.hasPrefix("tandem-step ") else { return }
                let step = String(line.dropFirst("tandem-step ".count))
                progress(step.hasSuffix(")") ? step : step + "…")
            }
            let lines = install.out.components(separatedBy: "\n")
            if let problem = lines.first(where: { $0.hasPrefix("tandem-error ") }) {
                throw SSHFailure(message: String(problem.dropFirst("tandem-error ".count)))
            }
            guard lines.contains("tandem-installed") else { throw SSHFailure(message: "Installing Tandem on the server failed.") }
        }
        try Task.checkCancellation()
        progress("Starting Tandem on the server…")
        let (port, token) = try await serve(id: files.id)
        progress("Connected.")
        let running = SSHSession(server: server, client: client, remotePort: port, token: token)
        running.serveTask = serveTask
        serveTask = nil
        client.onDisconnect { [weak running] in
            guard let running, !running.closed else { return }
            running.onLost?()
        }
        return running
    }

    // Starts the runtime on the server; it runs while this connection is open.
    private func serve(id: String) async throws -> (Int, String) {
        let folder = Data(server.folder.isEmpty ? "~".utf8 : server.folder.utf8).base64EncodedString()
        let stream = try await client.executeCommandStream("sh ~/.tandem/remote/\(id)/bootstrap.sh serve \(id) \(folder)")
        return try await withCheckedThrowingContinuation { continuation in
            let once = Once()
            serveTask = Task {
                var out = ""
                do {
                    for try await chunk in stream {
                        guard case .stdout(let buffer) = chunk else { continue }
                        out += String(buffer: buffer)
                        if let problem = out.components(separatedBy: "\n").first(where: { $0.hasPrefix("tandem-error ") }), once.claim() {
                            continuation.resume(throwing: SSHFailure(message: String(problem.dropFirst("tandem-error ".count))))
                        }
                        if !once.done,
                           let url = out.range(of: #"http://127\.0\.0\.1:(\d+)/"#, options: .regularExpression),
                           let tokenLine = out.components(separatedBy: "\n").first(where: { $0.hasPrefix("token=") && $0.count > 10 }) {
                            let portText = out[url].replacingOccurrences(of: "http://127.0.0.1:", with: "").replacingOccurrences(of: "/", with: "")
                            if let port = Int(portText), once.claim() {
                                continuation.resume(returning: (port, String(tokenLine.dropFirst("token=".count)).trimmingCharacters(in: .whitespacesAndNewlines)))
                            }
                        }
                    }
                } catch {}
                if once.claim() {
                    continuation.resume(throwing: SSHFailure(message: "Tandem stopped on the server before it was ready."))
                }
            }
        }
    }

    func tunnel(onData: @escaping (Data) -> Void, onClose: @escaping () -> Void) async throws -> SSHTunnel {
        let channel = try await client.createDirectTCPIPChannel(
            using: SSHChannelType.DirectTCPIP(
                targetHost: "127.0.0.1",
                targetPort: remotePort,
                originatorAddress: try SocketAddress(ipAddress: "127.0.0.1", port: 0)
            )
        ) { channel in
            channel.pipeline.addHandler(TunnelInbound(onData: onData, onClose: onClose))
        }
        return SSHTunnel(channel: channel)
    }

    func close() {
        guard !closed else { return }
        closed = true
        serveTask?.cancel()
        let client = client
        Task { try? await client.close() } // the runtime on the server stops with the connection
    }
}
