import Foundation
import Security

// Which AI provider and model the assistant uses. Keys go in the iPad
// Keychain; the page only ever learns that a key is saved (and its last four
// characters). Same shape and rules as the desktop runtime's ai_settings.py.
//
// If the Keychain isn't available to the app (some signing setups), keys go to
// a file in the app's private Application Support folder instead, encrypted by
// iPadOS data protection and excluded from backups.
final class AISettingsStore {
    struct Provider {
        let label: String
        let needsKey: Bool
        let baseURL: String
        let model: String
    }

    static let providers: [String: Provider] = [
        "anthropic": Provider(label: "Anthropic", needsKey: true, baseURL: "https://api.anthropic.com", model: "claude-opus-5-5"),
        "openai": Provider(label: "OpenAI-compatible", needsKey: true, baseURL: "https://api.openai.com/v1", model: ""),
        "ollama": Provider(label: "Ollama (local)", needsKey: false, baseURL: "http://127.0.0.1:11434", model: ""),
    ]
    static let order = ["anthropic", "openai", "ollama"]
    private let defaults = UserDefaults.standard
    private let service = "app.tandem.ai"

    private var config: [String: Any] {
        get { defaults.dictionary(forKey: "tandem.ai") ?? [:] }
        set { defaults.set(newValue, forKey: "tandem.ai") }
    }

    func providerConfig(_ name: String) -> (baseURL: String, model: String) {
        let saved = (config["providers"] as? [String: [String: String]])?[name] ?? [:]
        let base = saved["base_url"].flatMap { $0.isEmpty ? nil : $0 } ?? Self.providers[name]!.baseURL
        return (base, saved["model"] ?? Self.providers[name]!.model)
    }

    func publicSettings() -> [String: Any] {
        var providers: [String: Any] = [:]
        for name in Self.order {
            let meta = Self.providers[name]!
            let cfg = providerConfig(name)
            let key = self.key(name)
            var hint: Any = NSNull()
            if let key { hint = key.count >= 12 ? "…" + String(key.suffix(4)) : "saved" }
            providers[name] = ["label": meta.label, "needs_key": meta.needsKey, "base_url": cfg.baseURL, "model": cfg.model,
                               "default_base_url": meta.baseURL, "has_key": key != nil, "key_hint": hint] as [String: Any]
        }
        let storedIn = usesFallback ? "Tandem's encrypted app storage on this iPad" : "iPad Keychain"
        return ["active": config["active"] ?? NSNull(), "providers": providers, "stored_in": storedIn]
    }

    func update(_ body: [String: Any]) throws -> [String: Any] {
        guard let name = body["provider"] as? String, Self.providers[name] != nil else { throw APIError(status: 400, message: "Unknown provider.") }
        var cfg = config
        var all = cfg["providers"] as? [String: [String: String]] ?? [:]
        var entry = all[name] ?? [:]
        if let model = body["model"] as? String {
            let m = model.trimmingCharacters(in: .whitespaces)
            if m.count > 300 { throw APIError(status: 400, message: "The model name is too long.") }
            entry["model"] = m
        }
        if let base = body["base_url"] as? String {
            let b = base.trimmingCharacters(in: .whitespaces)
            entry["base_url"] = try b.isEmpty ? "" : Self.checkURL(b)
        }
        all[name] = entry
        cfg["providers"] = all
        if let activate = body["activate"] as? Bool {
            if activate { cfg["active"] = name } else if (cfg["active"] as? String) == name { cfg["active"] = nil }
        }
        if (body["clear_key"] as? Bool) == true {
            deleteKey(name)
        } else if let key = body["api_key"] as? String {
            let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
            if k.isEmpty { throw APIError(status: 400, message: "Paste a key, or remove the saved one.") }
            if k.count > 512 || k.contains(where: { $0.isWhitespace }) {
                throw APIError(status: 400, message: "That doesn't look like an API key (no spaces, at most 512 characters).")
            }
            try saveKey(name, k)
        }
        config = cfg
        return publicSettings()
    }

    static func checkURL(_ url: String) throws -> String {
        guard let u = URL(string: url), let scheme = u.scheme, ["http", "https"].contains(scheme), let host = u.host, url.count <= 300 else {
            throw APIError(status: 400, message: "Enter a full address starting with https:// (or http:// for a local server).")
        }
        if scheme == "http" && !["localhost", "127.0.0.1", "::1"].contains(host.lowercased()) {
            throw APIError(status: 400, message: "Use https:// for remote servers; plain http:// is only allowed on this iPad.")
        }
        return url.hasSuffix("/") ? String(url.dropLast()) : url
    }

    // MARK: fallback file (only when the Keychain refuses)

    private var fallbackURL: URL? {
        guard let dir = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        return dir.appendingPathComponent("ai-keys.json")
    }

    private var fallbackKeys: [String: String] {
        get {
            guard let url = fallbackURL, let data = try? Data(contentsOf: url) else { return [:] }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: String] ?? [:]
        }
        set {
            guard var url = fallbackURL else { return }
            if newValue.isEmpty { try? FileManager.default.removeItem(at: url); return }
            if let data = try? JSONSerialization.data(withJSONObject: newValue) {
                try? data.write(to: url, options: [.atomic, .completeFileProtection])
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? url.setResourceValues(values)
            }
        }
    }

    private var usesFallback: Bool { !fallbackKeys.isEmpty }

    // MARK: Keychain

    func key(_ provider: String) -> String? {
        keychainKey(provider) ?? fallbackKeys[provider]
    }

    private func keychainKey(_ provider: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: provider, kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func saveKey(_ provider: String, _ value: String) throws {
        deleteKey(provider)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: provider, kSecValueData as String: Data(value.utf8),
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemAdd(query as CFDictionary, nil) != errSecSuccess {
            var keys = fallbackKeys
            keys[provider] = value
            fallbackKeys = keys
        }
    }

    private func deleteKey(_ provider: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: provider]
        SecItemDelete(query as CFDictionary)
        var keys = fallbackKeys
        if keys.removeValue(forKey: provider) != nil { fallbackKeys = keys }
    }
}
