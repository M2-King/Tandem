import Citadel
import Crypto
import SwiftUI
import UniformTypeIdentifiers

// "Connect to SSH server…" on iPad: a native sheet, apart from the Tandem
// page, so passwords, keys and passphrases are typed and used only in the app.
// Saved servers (no secrets) are kept in the app's settings; a password, or a
// key and its passphrase, only when "Remember" is on, in the Keychain.

@MainActor
final class ConnectModel: ObservableObject {
    @Published var host = ""
    @Published var port = "22"
    @Published var username = ""
    @Published var folder = "~"
    @Published var useKey = false
    @Published var password = ""
    @Published var keyText = ""
    @Published var passphrase = ""
    @Published var remember = false
    @Published var fullTools = false // also install notebooks and the debugger
    @Published var busy = false
    @Published var status = ""
    @Published var error: String?
    @Published var hostKey: HostKeyInfo?
    @Published var saved: [SSHServer] = []

    private let secure = SecureStore()
    private let known = KnownHosts()
    private var hostKeyAnswer: CheckedContinuation<Bool, Never>?
    // The connection being set up, so Cancel can stop it.
    private var connecting: Task<Void, Never>?
    private var pendingClient: SSHClient?
    private var cancelled = false
    let onConnected: (SSHSession) -> Void
    private static let savedKey = "tandem.ssh.servers"

    init(prefill: SSHServer? = nil, onConnected: @escaping (SSHSession) -> Void) {
        self.onConnected = onConnected
        saved = Self.loadSaved()
        if let server = prefill ?? saved.first { fill(server) }
    }

    private static func loadSaved() -> [SSHServer] {
        guard let data = UserDefaults.standard.data(forKey: savedKey),
              let list = try? JSONDecoder().decode([SSHServer].self, from: data) else { return [] }
        return list
    }

    private func save(_ server: SSHServer) {
        saved = [server] + saved.filter { $0.id != server.id }
        if let data = try? JSONEncoder().encode(Array(saved.prefix(20))) { UserDefaults.standard.set(data, forKey: Self.savedKey) }
    }

    // Keychain names: letters, numbers and . _ : - only.
    private func secretName(_ server: SSHServer, _ what: String) -> String {
        let digest = SHA256.hash(data: Data(server.id.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16)
        return "ssh.\(digest).\(what)"
    }

    func fill(_ server: SSHServer) {
        host = server.host
        port = String(server.port)
        username = server.username
        folder = server.folder
        useKey = server.auth == "key"
        password = (try? secure.get(secretName(server, "password"))) ?? ""
        keyText = (try? secure.get(secretName(server, "key"))) ?? ""
        passphrase = (try? secure.get(secretName(server, "passphrase"))) ?? ""
        remember = !(useKey ? keyText : password).isEmpty
        error = nil
    }

    func forget(_ server: SSHServer) {
        saved.removeAll { $0.id == server.id }
        if let data = try? JSONEncoder().encode(saved) { UserDefaults.standard.set(data, forKey: Self.savedKey) }
        for what in ["password", "key", "passphrase"] { try? secure.set(secretName(server, what), nil) }
        known.forget(server.host, server.port)
    }

    func importKey(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if let data = try? Data(contentsOf: url), data.count < 32 * 1024, let text = String(data: data, encoding: .utf8) {
            keyText = text
        } else {
            error = "Tandem couldn't read that file as a private key."
        }
    }

    private func target() throws -> SSHServer {
        let h = host.trimmingCharacters(in: .whitespaces)
        let u = username.trimmingCharacters(in: .whitespaces)
        guard !h.isEmpty, h.range(of: #"^[A-Za-z0-9.\-:\[\]_]{1,253}$"#, options: .regularExpression) != nil else {
            throw SSHFailure(message: "Enter the server's address (a host name or IP address).")
        }
        guard !u.isEmpty, u.range(of: #"^[A-Za-z0-9._@\-\\]{1,64}$"#, options: .regularExpression) != nil else {
            throw SSHFailure(message: "Enter your username on the server.")
        }
        guard let p = Int(port.trimmingCharacters(in: .whitespaces)), (1...65535).contains(p) else {
            throw SSHFailure(message: "The port is a number from 1 to 65535 (usually 22).")
        }
        let f = folder.trimmingCharacters(in: .whitespaces)
        return SSHServer(host: h, port: p, username: u, folder: f.isEmpty ? "~" : f, auth: useKey ? "key" : "password")
    }

    func askHostKey(_ info: HostKeyInfo) async -> Bool {
        await withCheckedContinuation { continuation in
            hostKeyAnswer = continuation
            hostKey = info
            status = "Waiting for you to confirm the server's identity."
        }
    }

    func answerHostKey(_ yes: Bool) {
        hostKeyAnswer?.resume(returning: yes)
        hostKeyAnswer = nil
        hostKey = nil
    }

    func connect() {
        error = nil
        let server: SSHServer
        do { server = try target() } catch { self.error = error.localizedDescription; return }
        if useKey && keyText.isEmpty { error = "Paste your private key, or choose its file."; return }
        if !useKey && password.isEmpty { error = "Enter your password."; return }
        let auth: SSHAuthInput = useKey ? .key(text: keyText, passphrase: passphrase) : .password(password)
        busy = true
        cancelled = false
        status = "Connecting…"
        connecting = Task {
            do {
                let session = try await SSHSession.connect(
                    server: server, auth: auth, known: known,
                    confirm: { [weak self] info in await self?.askHostKey(info) ?? false },
                    progress: { [weak self] text in Task { @MainActor in if self?.cancelled == false { self?.status = text } } },
                    fullTools: fullTools,
                    onClient: { [weak self] client in
                        Task { @MainActor in
                            guard let self else { return }
                            self.pendingClient = client
                            if self.cancelled { try? await client.close() }
                        }
                    }
                )
                pendingClient = nil
                if cancelled { session.close(); return }
                save(server)
                // Kept only when asked; forgotten when the switch is off.
                let secrets: [(String, String)] = useKey ? [("key", keyText), ("passphrase", passphrase)] : [("password", password)]
                for (what, value) in secrets { try? secure.set(secretName(server, what), remember && !value.isEmpty ? value : nil) }
                busy = false
                onConnected(session)
            } catch {
                pendingClient = nil
                if cancelled { return }
                busy = false
                status = ""
                self.error = error.localizedDescription
            }
        }
    }

    // Stops connecting. An install already under way carries on on the
    // server by itself; the next connection finds it finished, or waits for it.
    func cancel() {
        guard busy else { return }
        cancelled = true
        connecting?.cancel()
        answerHostKey(false)
        if let client = pendingClient { Task { try? await client.close() } }
        pendingClient = nil
        busy = false
        status = ""
    }
}

struct ConnectView: View {
    @ObservedObject var model: ConnectModel
    let onCancel: () -> Void
    @State private var importing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Open a folder on a server: you edit its files here, and Run, notebooks and the Terminal use the server's Python.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !model.saved.isEmpty {
                    Section("Saved servers") {
                        ForEach(model.saved) { server in
                            Button {
                                model.fill(server)
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(server.label)
                                    Text(server.folder).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .swipeActions { Button("Forget", role: .destructive) { model.forget(server) } }
                        }
                    }
                }
                Section("Server") {
                    TextField("Server (lab.example.edu)", text: $model.host)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    TextField("Port", text: $model.port).keyboardType(.numberPad)
                    TextField("Username", text: $model.username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Folder on the server", text: $model.folder)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section("Sign in with") {
                    Picker("Sign in with", selection: $model.useKey) {
                        Text("Password").tag(false)
                        Text("SSH key").tag(true)
                    }
                    .pickerStyle(.segmented)
                    if model.useKey {
                        TextEditor(text: $model.keyText)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 90)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .overlay(alignment: .topLeading) {
                                if model.keyText.isEmpty {
                                    Text("Paste your private key (-----BEGIN OPENSSH PRIVATE KEY-----…)")
                                        .font(.caption).foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 4).allowsHitTesting(false)
                                }
                            }
                        Button("Choose a key file…") { importing = true }
                        SecureField("Passphrase (if the key has one)", text: $model.passphrase)
                    } else {
                        SecureField("Password", text: $model.password)
                    }
                    Toggle(model.useKey ? "Remember the key on this iPad" : "Remember the password on this iPad", isOn: $model.remember)
                }
                Section {
                    Toggle("Also install notebooks and the debugger", isOn: $model.fullTools)
                } footer: {
                    Text(model.fullTools
                         ? "Tandem installs its tools in ~/.tandem on the server the first time (about 15–50 MB, from the fastest of PyPI and its mirrors in China)."
                         : "Nothing is installed on the server: you get its files, the Terminal and Run, with the server's own python3.")
                }
                if !model.status.isEmpty || model.error != nil {
                    Section {
                        if let error = model.error {
                            Text(error).foregroundStyle(.red).font(.callout)
                        } else {
                            HStack(spacing: 8) {
                                if model.busy { ProgressView() }
                                Text(model.status).font(.callout).foregroundStyle(.secondary)
                            }
                            if model.busy {
                                Text("You can cancel: an install already under way finishes on the server by itself, and the next connection uses it.")
                                    .font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                Section {
                    Text("Linux or macOS servers. Code you run there runs with your account on that server. The assistant and Shared projects stay on this iPad.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Connect to an SSH server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        model.cancel()
                        onCancel()
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Connect") { model.connect() }.disabled(model.busy) }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.data, .text, .item]) { result in
                if case .success(let url) = result { model.importKey(url) }
            }
            .alert(
                "First connection to \(model.hostKey.map { "\($0.host)\($0.port == 22 ? "" : ":\($0.port)")" } ?? "")",
                isPresented: Binding(get: { model.hostKey != nil }, set: { if !$0 { model.answerHostKey(false) } }),
                presenting: model.hostKey
            ) { _ in
                Button("Cancel", role: .cancel) { model.answerHostKey(false) }
                Button("Trust and connect") { model.answerHostKey(true) }
            } message: { info in
                Text("The server identifies itself with this \(info.type) key:\n\n\(info.fingerprint)\n\nIf you can, check it with the server's admin. Tandem remembers it and warns if it ever changes.")
            }
        }
    }
}

// One sheet per model (SwiftUI's .sheet(item:)).
extension ConnectModel: Identifiable {}
