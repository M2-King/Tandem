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
                    WebView(url: url, origin: host.origin)
                        .ignoresSafeArea(.container, edges: .bottom)
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
    private var server: LocalServer?
    var origin: String { url.map { "\($0.scheme!)://\($0.host!):\($0.port!)" } ?? "" }

    init() { ensureRunning() }

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
