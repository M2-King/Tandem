import CryptoKit
import Foundation

struct APIError: Error {
    let status: Int
    let message: String
}

// Projects are folders in the app's Documents folder, which the Files app shows
// as On My iPad › Tandem. Paths from the page are always relative and stay
// inside the open project (same rules as the desktop runtime's files.py).
final class ProjectStore {
    static let skipDirs: Set<String> = [".git", ".hg", ".svn", ".venv", "venv", "env", "__pycache__", "node_modules", ".tandem",
                                        ".ipynb_checkpoints", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vscode"]
    static let maxTextBytes = 2 * 1024 * 1024
    static let maxFiles = 2000
    static let starter = "name = input(\"What is your name? \")\nprint(f\"Hello, {name}!\")\n"

    let documents: URL
    private(set) var current: String
    private let fm = FileManager.default

    init() throws {
        documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let saved = UserDefaults.standard.string(forKey: "tandem.project")
        let names = Self.projectNames(in: documents)
        if names.isEmpty {
            let first = documents.appendingPathComponent("My Project", isDirectory: true)
            try FileManager.default.createDirectory(at: first, withIntermediateDirectories: true)
            try Data(Self.starter.utf8).write(to: first.appendingPathComponent("hello.py"))
            current = "My Project"
        } else if let saved, names.contains(saved) {
            current = saved
        } else {
            current = names[0]
        }
    }

    static func projectNames(in documents: URL) -> [String] {
        let items = (try? FileManager.default.contentsOfDirectory(at: documents, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return items.filter { url in
            !url.lastPathComponent.hasPrefix(".") && ((try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false)
        }.map { $0.lastPathComponent }.sorted()
    }

    var root: URL { documents.appendingPathComponent(current, isDirectory: true).standardizedFileURL }

    // MARK: projects

    func projects() -> [String] { Self.projectNames(in: documents) }

    func open(_ name: String, create: Bool) throws {
        let valid = name.range(of: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$", options: .regularExpression) != nil
        guard valid else { throw APIError(status: 400, message: "Use letters, numbers, spaces, dots, dashes or underscores.") }
        let folder = documents.appendingPathComponent(name, isDirectory: true)
        if create {
            if fm.fileExists(atPath: folder.path) { throw APIError(status: 400, message: "\(name) already exists.") }
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("print(\"Hello from Tandem\")\n".utf8).write(to: folder.appendingPathComponent("main.py"))
        } else if !fm.fileExists(atPath: folder.path) {
            throw APIError(status: 404, message: "There is no project called \(name).")
        }
        current = name
        UserDefaults.standard.set(name, forKey: "tandem.project")
    }

    // MARK: files

    func resolve(_ rel: String) throws -> URL {
        if rel.isEmpty || rel.hasPrefix("/") || rel.contains("\\") || rel.split(separator: "/").contains("..") {
            throw APIError(status: 400, message: "\(rel) is outside the project.")
        }
        let url = root.appendingPathComponent(rel).standardizedFileURL
        let resolved = url.resolvingSymlinksInPath()
        let base = root.resolvingSymlinksInPath().path
        guard resolved.path == base || resolved.path.hasPrefix(base + "/") else {
            throw APIError(status: 400, message: "\(rel) is outside the project.")
        }
        return url
    }

    func list() -> [[String: Any]] {
        var out: [[String: Any]] = []
        func walk(_ dir: URL, _ prefix: String) {
            let items = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .isSymbolicLinkKey])) ?? []
            for item in items.sorted(by: { $0.lastPathComponent.lowercased() < $1.lastPathComponent.lowercased() }) {
                let name = item.lastPathComponent
                if name.hasPrefix(".") || Self.skipDirs.contains(name) || out.count >= Self.maxFiles { continue }
                let values = try? item.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .isSymbolicLinkKey])
                let rel = prefix.isEmpty ? name : "\(prefix)/\(name)"
                if values?.isSymbolicLink == true, (try? resolve(rel)) == nil { continue }
                if values?.isDirectory == true { walk(item, rel) } else { out.append(["path": rel, "size": values?.fileSize ?? 0]) }
            }
        }
        walk(root, "")
        return out
    }

    static func hash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    func read(_ rel: String) throws -> [String: Any] {
        let url = try resolve(rel)
        guard let data = fm.contents(atPath: url.path) else { throw APIError(status: 400, message: "\(rel) doesn't exist.") }
        if data.count > Self.maxTextBytes { return ["path": rel, "text": NSNull(), "reason": "too-large", "size": data.count] }
        if data.prefix(8192).contains(0) { return ["path": rel, "text": NSNull(), "reason": "binary", "size": data.count] }
        guard let text = String(data: data, encoding: .utf8) else { return ["path": rel, "text": NSNull(), "reason": "not-utf8", "size": data.count] }
        return ["path": rel, "text": text, "hash": Self.hash(text), "size": data.count]
    }

    func write(_ rel: String, text: String, baseHash: String?, create: Bool) throws -> [String: Any] {
        let url = try resolve(rel)
        var isDir: ObjCBool = false
        let exists = fm.fileExists(atPath: url.path, isDirectory: &isDir)
        if exists && isDir.boolValue { throw APIError(status: 400, message: "\(rel) is a folder.") }
        if create && exists { throw APIError(status: 400, message: "\(rel) already exists.") }
        if !create && !exists { throw APIError(status: 400, message: "\(rel) doesn't exist.") }
        if let baseHash, !baseHash.isEmpty, exists, let current = try? read(rel), let h = current["hash"] as? String, h != baseHash {
            throw APIError(status: 400, message: "\(rel) changed on disk since it was opened.")
        }
        let data = Data(text.utf8)
        if data.count > Self.maxTextBytes { throw APIError(status: 400, message: "\(rel) is larger than 2 MB.") }
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return ["path": rel, "hash": Self.hash(text), "size": data.count]
    }

    func readRaw(_ rel: String) throws -> Data {
        let url = try resolve(rel)
        guard let data = fm.contents(atPath: url.path) else { throw APIError(status: 404, message: "No such file.") }
        return data
    }

    func writeRaw(_ rel: String, data: Data) throws {
        let url = try resolve(rel)
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }
}
