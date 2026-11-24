import SwiftUI

// Tandem for iPad. The app is a full-screen web view of the Tandem UI, served
// by a small HTTP server on 127.0.0.1 inside the app (LocalServer). Python
// runs in the page (Pyodide). Projects live in Files › On My iPad › Tandem;
// AI keys live in the iPad Keychain and never reach the page.
@main
struct TandemApp: App {
    @StateObject private var host = AppHost()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ZStack {
                Color(red: 0.067, green: 0.078, blue: 0.102).ignoresSafeArea()
                if let url = host.url {
                    // Edge to edge: the page keeps its controls clear of the status
                    // bar and window controls itself (CSS safe-area insets).
                    WebView(url: url, origin: host.origin, reloadToken: host.reloadToken) { type in
                        if type == "connect" { host.showConnect() } else { host.disconnect() }
                    }
                    .ignoresSafeArea()
                } else if let error = host.error {
                    VStack(spacing: 12) {
                        Text("Tandem couldn't start").font(.headline)
                        Text(error).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .foregroundStyle(.white)
                    .padding(40)
                }
            }
            .preferredColorScheme(.dark)
            .sheet(item: $host.connect) { model in
                ConnectView(model: model) { host.connect = nil }
                    .interactiveDismissDisabled(model.busy)
            }
            .alert("Disconnected", isPresented: Binding(get: { host.lostMessage != nil }, set: { if !$0 { host.lostMessage = nil } })) {
                Button("OK", role: .cancel) { host.lostMessage = nil }
            } message: {
                Text(host.lostMessage ?? "")
            }
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { host.ensureRunning() }
        }
    }
}

@MainActor
final class AppHost: ObservableObject {
    @Published var url: URL?
    @Published var error: String?
    @Published var reloadToken = 0
    @Published var connect: ConnectModel?
    @Published var lostMessage: String?
    private var server: LocalServer?
    private var session: SSHSession? // a project on an SSH server, while connected
    var origin: String { url.map { "\($0.scheme!)://\($0.host!):\($0.port!)" } ?? "" }

    init() {
        ensureRunning()
        connectForTests()
    }

    // CI only (the simulator): connect to the test server named in
    // TANDEM_SSH_TEST (base64 JSON: host, port, user, folder, key, fingerprint),
    // trusting only that host key, as if someone had used the sheet.
    private func connectForTests() {
        #if targetEnvironment(simulator)
        guard let encoded = ProcessInfo.processInfo.environment["TANDEM_SSH_TEST"],
              let data = Data(base64Encoded: encoded),
              let test = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let host = test["host"] as? String, let user = test["user"] as? String,
              let key = test["key"] as? String, let expected = test["fingerprint"] as? String else { return }
        let server = SSHServer(host: host, port: test["port"] as? Int ?? 22, username: user, folder: test["folder"] as? String ?? "~", auth: "key")
        Task {
            do {
                let session = try await SSHSession.connect(
                    server: server, auth: .key(text: key, passphrase: nil), known: KnownHosts(),
                    confirm: { info in info.fingerprint == expected },
                    progress: { print("TANDEM-SSH " + $0) }
                )
                print("TANDEM-SSH connected to \(server.label)")
                connected(session)
            } catch {
                print("TANDEM-SSH failed: \(error.localizedDescription)")
            }
        }
        #endif
    }

    // Projects on an SSH server: the sheet, then the page again with the server's runtime behind it.
    func showConnect() {
        guard connect == nil else { return }
        connect = ConnectModel(prefill: session?.server) { [weak self] session in
            Task { @MainActor in self?.connected(session) }
        }
    }

    private func connected(_ new: SSHSession) {
        session?.close()
        session = new
        server?.remote = new
        new.onLost = { [weak self] in
            Task { @MainActor in
                guard let self, self.session === new else { return }
                self.lostMessage = "The connection to \(new.server.label) closed. Tandem is back on this iPad's projects; connect again from ⋯ when the server is reachable."
                self.disconnect()
            }
        }
        connect = nil
        reloadToken += 1
    }

    func disconnect() {
        guard let session else { return }
        server?.remote = nil
        session.close()
        self.session = nil
        reloadToken += 1
    }

    func ensureRunning() {
        if let server, server.isRunning { return }
        do {
            let store = try ProjectStore()
            let server = try LocalServer(store: store, ai: AISettingsStore(), selftest: ProcessInfo.processInfo.environment["TANDEM_SELFTEST"] == "1")
            try server.start()
            self.server = server
            self.url = URL(string: "http://127.0.0.1:\(server.port)/")
            self.error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
