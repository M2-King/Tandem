import Foundation
import Security

// Small secrets the page asks the app to keep for it between launches: today,
// the Cowork sign-in ("Keep me signed in"). In the iPad Keychain, for this
// device only; if the Keychain isn't available to the app (some signing
// setups), in a file in the app's private Application Support folder,
// encrypted by iPadOS data protection and excluded from backups (as AI keys).
//
// Only the page with the session token can reach it (LocalServer checks the
// token, host and origin). Names are checked and values are limited in size.
final class SecureStore {
    private let service = "app.tandem.secure"
    static let maxValue = 32 * 1024

    static func check(name: String) throws {
        let ok = !name.isEmpty && name.count <= 120
            && name.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || "._:-".unicodeScalars.contains($0) }
        if !ok { throw APIError(status: 400, message: "That name can't be stored.") }
    }

    func get(_ name: String) throws -> String? {
        try Self.check(name: name)
        return keychainValue(name) ?? fallback[name]
    }

    /// Saves `value`, or removes the name when `value` is nil.
    func set(_ name: String, _ value: String?) throws {
        try Self.check(name: name)
        delete(name)
        guard let value else { return }
        if value.utf8.count > Self.maxValue { throw APIError(status: 400, message: "That value is too large to store.") }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: name, kSecValueData as String: Data(value.utf8),
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemAdd(query as CFDictionary, nil) != errSecSuccess {
            var all = fallback
            all[name] = value
            fallback = all
        }
    }

    // MARK: Keychain

    private func keychainValue(_ name: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: name, kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func delete(_ name: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: name]
        SecItemDelete(query as CFDictionary)
        var all = fallback
        if all.removeValue(forKey: name) != nil { fallback = all }
    }

    // MARK: fallback file (only when the Keychain refuses)

    private var fallbackURL: URL? {
        guard let dir = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return nil }
        return dir.appendingPathComponent("secure-values.json")
    }

    private var fallback: [String: String] {
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
}
